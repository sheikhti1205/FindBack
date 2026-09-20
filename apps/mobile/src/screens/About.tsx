import { useEffect, useState } from "react";
import { BackButton } from "../components/BackButton";
import { getVlmBridge, type VlmCapabilities } from "../services/vlmPlugin";
import { APP_VERSION, BACKEND_SCHEMA_VERSION, CAPABILITIES_VERSION } from "../services/appCapabilities";

function shortSha(sha: string | null | undefined): string {
  if (!sha || sha === "unknown") return "unknown";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * Profile → About: build identity for release diagnosis. App version comes
 * from package.json; build SHA and versionCode come from the installed native
 * build when running on Android.
 */
export function About() {
  const [caps, setCaps] = useState<VlmCapabilities | null>(null);

  useEffect(() => {
    let mounted = true;
    getVlmBridge()
      .getCapabilities()
      .then((c) => {
        if (mounted) setCaps(c);
      })
      .catch(() => {
        // Web adapter or unavailable bridge: static metadata still shows.
      });
    return () => {
      mounted = false;
    };
  }, []);

  const fullSha = caps?.buildGitSha ?? null;

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      <header className="flex min-w-0 items-center gap-2">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">About</h1>
      </header>

      <dl className="flex min-w-0 flex-col gap-3 rounded-m3-md border border-outline-variant bg-surface-container-low p-4 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-on-surface-variant">App</dt>
          <dd className="min-w-0 break-words font-medium">FindBack {APP_VERSION}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-on-surface-variant">Build</dt>
          <dd className="min-w-0 break-words font-medium" title={fullSha ?? undefined}>
            {shortSha(fullSha)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-on-surface-variant">Version code</dt>
          <dd className="min-w-0 break-words font-medium">
            {typeof caps?.versionCode === "number" && caps.versionCode > 0 ? caps.versionCode : "unknown"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-on-surface-variant">Expected backend/schema capability</dt>
          <dd className="min-w-0 break-words font-medium">{BACKEND_SCHEMA_VERSION}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-on-surface-variant">Help capability</dt>
          <dd className="min-w-0 break-words font-medium">{CAPABILITIES_VERSION}</dd>
        </div>
      </dl>
    </div>
  );
}
