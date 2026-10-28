// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseMediaTransport } from "./supabaseSession";
import { createSupabaseFunctionFetch } from "../supabaseClient";
import { mediaFixture } from "./mediaTestDoubles";

const current = vi.hoisted(() => ({ sdk: null as unknown, raw: null as unknown }));
vi.mock("../supabaseClient", async (original) => ({ ...await original<typeof import("../supabaseClient")>(),
  getSupabase: () => current.sdk,
  fetchSupabaseFunction: (...args: unknown[]) => (current.raw as (...args: unknown[]) => unknown)(...args),
}));
// All keys, auth and account identifiers below are synthetic, never deployed.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => { current.sdk = null; current.raw = null; });

describe("canonical Supabase media composition", () => {
  it("uses real SDK RPCs and authenticated raw bytes with captured account/installation", async () => {
    const { metadata, bytes } = await mediaFixture(id(3), id(4), { expiresAt: Date.now() + 60_000 });
    const scope = { accountId: id(1), deviceId: id(2) }, controller = new AbortController();
    const requests: Request[] = [];
    const publicMetadata = { attachmentId: id(3), sha256: metadata.sha256, mime: metadata.mime,
      bytes: metadata.byteSize, width: metadata.width, height: metadata.height };
    const network: typeof fetch = async (input, init) => {
      const req = new Request(input, init); requests.push(req);
      if (req.url.endsWith("findback_fetch_chat_media_delivery")) return Response.json([{ version: 1, ...publicMetadata,
        messageId: id(4), expiresAt: new Date(metadata.expiresAt!).toISOString() }]);
      if (req.url.endsWith("findback_ack_chat_media_delivery")) return new Response(null, { status: 204 });
      if (req.method === "GET") return new Response(bytes.slice(0), { headers: { "content-type": "image/png" } });
      return Response.json(publicMetadata);
    };
    const config = { url: "https://project.example.test", key: "sb_publishable_synthetic" };
    current.sdk = createClient(config.url, config.key, { accessToken: async () => "synthetic-token-a", global: { fetch: network } });
    current.raw = createSupabaseFunctionFetch(config, { getSession: async () => ({ data: {
      session: { user: { id: id(1) }, access_token: "synthetic-token-a" } }, error: null }) }, network);
    const media = createSupabaseMediaTransport(scope, controller.signal);
    scope.accountId = id(9); scope.deviceId = id(8);
    await media.upload(metadata, bytes);
    expect(await media.download(metadata)).toEqual(bytes);
    expect(await media.fetchDeliveries()).toHaveLength(1);
    await media.ack(id(3));
    expect(requests).toHaveLength(4);
    expect(await requests[0]!.arrayBuffer()).toEqual(bytes);
    for (const req of requests) expect(req.headers.get("authorization")).toBe("Bearer synthetic-token-a");
    expect(await requests[2]!.json()).toEqual({ p_account_id: id(1), p_device_id: id(2) });
    expect(await requests[3]!.json()).toEqual({ p_account_id: id(1), p_device_id: id(2), p_attachment_id: id(3) });
    controller.abort();
    await expect(media.ack(id(3))).rejects.toThrow(); expect(requests).toHaveLength(4);
  });
});
