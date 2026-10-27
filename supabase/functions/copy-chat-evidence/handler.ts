import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import { copyOneChatEvidence, type EvidenceCopyPorts } from "../_shared/chatEvidenceCopy.ts";

// Narrow schema for the two service-only boundaries used here, not an untyped
// admin client or a copy of the rest of the application's generated schema.
type EvidenceDatabase = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      findback_claim_chat_media_evidence_job: { Args: Record<string, never>; Returns: unknown };
      findback_finish_chat_media_evidence_job: {
        Args: { p_evidence_id: string; p_generation: string; p_work_token: string; p_object_key: string;
          p_sha: string; p_mime: string; p_bytes: number; p_width: number; p_height: number };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** env/fetch overrides support hermetic testing and non-Deno hosts. Neither is
 * accepted from HTTP input. Runtime credentials remain inside the auth owner. */
export function createEvidenceCopyEndpoint(env?: Partial<SupabaseEnv>, transport: typeof fetch = fetch) {
  // One large byte-copy attempt per endpoint/isolate, not a distributed cap.
  // Busy authenticated requests fail before claiming/allocating another job.
  let copying = false;
  return async (request: Request): Promise<Response> => {
    const respond = (body: object, status: number) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    // Reject caller-selected work before withSupabase's body buffering. Cron
    // must send an empty POST; no reporter, key, bucket or batch size is input.
    if (request.body !== null) {
      void request.body.cancel().catch(() => {});
      return respond({ error: "Empty request required" }, 400);
    }
    const invocationAbort = new AbortController();
    const invocationSignal = AbortSignal.any([request.signal, invocationAbort.signal]);
    const timer = setTimeout(() => invocationAbort.abort(), 90_000);
    let activeSignal = invocationSignal;
    // Upload currently lacks an AbortSignal option in storage-js. Bind its
    // actual fetch too, not just the worker Promise or download/RPC options.
    const boundedFetch: typeof fetch = (input, init) => transport(input, {
      ...init,
      signal: AbortSignal.any([invocationSignal, activeSignal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : [])]),
    });
    const handler = withSupabase<EvidenceDatabase>({ auth: "secret", cors: false, env,
      errors: { detailed: false }, supabaseOptions: { global: { fetch: boundedFetch } },
    }, async (_req, ctx) => {
      if (copying) return respond({ status: "retry" }, 503);
      copying = true;
      try {
        const client = ctx.supabaseAdmin;
        const io: EvidenceCopyPorts = {
          async claim(signal) {
            activeSignal = signal;
            const { data, error } = await client.rpc("findback_claim_chat_media_evidence_job").abortSignal(signal);
            if (error) throw new Error("Work unavailable");
            return data;
          },
          async read(bucket, key, signal) {
            activeSignal = signal;
            const { data, error } = await client.storage.from(bucket).download(key, {}, { signal, cache: "no-store" }).asStream();
            if (error) {
              // SDK2.112.4 statusCode may be a symbolic body code, not HTTP status.
              // Reject proxy/non-JSON404 and missing buckets; only object absence
              // (modern code or exact legacy shape) permits a new immutable copy.
              if (error.status === 404 && ("code" in error && error.code === "NoSuchKey"
                || (!("code" in error) || error.code === undefined)
                  && error.statusCode === "404" && error.message === "Object not found")) return null;
              throw new Error("Evidence unavailable");
            }
            if (!data) throw new Error("Evidence unavailable");
            return data;
          },
          async write(job, bytes, signal) {
            activeSignal = signal;
            const { error } = await client.storage.from(job.bucket).upload(job.objectKey, bytes.slice(), {
              upsert: false, contentType: job.mime, cacheControl: "0",
            });
            if (error) throw new Error("Copy unavailable");
          },
          async finish(job, signal) {
            activeSignal = signal;
            const { error } = await client.rpc("findback_finish_chat_media_evidence_job", {
              p_evidence_id: job.id, p_generation: job.generation, p_work_token: job.workToken,
              p_object_key: job.objectKey, p_sha: job.sha256, p_mime: job.mime,
              p_bytes: job.bytes, p_width: job.width, p_height: job.height,
            }).abortSignal(signal);
            if (error) throw new Error("Finish unavailable");
          },
        };
        const result = await copyOneChatEvidence(io, { signal: invocationSignal });
        return respond(result, result.status === "retry" ? 503 : 200);
      } finally {
        copying = false;
      }
    });
    try {
      return await handler(request);
    } catch {
      return respond({ status: "retry" }, 503);
    } finally {
      clearTimeout(timer);
      invocationAbort.abort();
    }
  };
}
