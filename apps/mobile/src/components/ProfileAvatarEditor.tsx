import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { ApiError } from "../services/session";
import { removeAvatar, uploadAvatar, type AvatarSource } from "../services/avatar";
import { normalizeImage } from "../services/image";
import { chooseNativeImage, isNativeMediaIntakeAvailable } from "../services/media/nativeMedia";
import { UserAvatar } from "./UserAvatar";
import { Button } from "./Button";
import { SettingsGroup } from "./settings";

/**
 * Profile photo editor for the Edit-profile screen.
 *
 * Source selection reuses the canonical media pipeline on both platforms:
 * the native permissionless picker (`chooseNativeImage`, EXIF/location
 * stripped on-device) on Android, the file picker + `normalizeImage` on web.
 * Upload + URL persistence go through the avatar service (ownership-scoped
 * `avatars/{uid}/…` prefix, self-only `update_my_avatar` RPC); the reloaded
 * profile is pushed into auth state so every avatar surface (profile, public
 * profile, comment rows, composer) refreshes from the same source.
 *
 * Fail-closed: picker cancellation resolves to "no change" (never an error);
 * every failure keeps the previous avatar and shows one human message.
 */
export function ProfileAvatarEditor() {
  const { user, setUser } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!user) return null;

  async function run(label: "update" | "remove", work: () => Promise<boolean | void>) {
    if (busy.current) return;
    busy.current = true;
    setActionError(null);
    setStatus(null);
    setUploading(true);
    try {
      const changed = await work();
      if (!alive.current) return;
      // Picker cancellation resolves to "no change": settle silently, never
      // a success notice and never an error.
      if (changed === false) return;
      setStatus(label === "update" ? "Profile photo updated." : "Profile photo removed.");
    } catch (err) {
      if (!alive.current) return;
      setActionError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error && err.message
            ? err.message
            : "Could not update your profile photo. Check your connection and try again.",
      );
    } finally {
      busy.current = false;
      if (alive.current) setUploading(false);
    }
  }

  async function prepareNativeSource(): Promise<AvatarSource | null> {
    const picked = await chooseNativeImage({ source: "photos", fileName: "avatar.jpg" });
    if (!picked) return null;
    const bytes = picked.derivative.bytes;
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: picked.derivative.mimeType }),
      mimeType: picked.derivative.mimeType,
      fileName: picked.fileName,
    };
  }

  async function onChangeClick() {
    if (isNativeMediaIntakeAvailable()) {
      const current = user;
      if (!current) return;
      await run("update", async () => {
        const source = await prepareNativeSource();
        if (!source) return false;
        setUser(await uploadAvatar(source, current.avatarUrl));
      });
      return;
    }
    fileInputRef.current?.click();
  }

  async function onFileSelected(file: File) {
    const current = user;
    if (!current) return;
    await run("update", async () => {
      const normalized = await normalizeImage(file);
      setUser(
        await uploadAvatar(
          { blob: normalized.blob, mimeType: normalized.mimeType, fileName: file.name },
          current.avatarUrl,
        ),
      );
    });
  }

  async function onRemoveClick() {
    const current = user;
    if (!current) return;
    await run("remove", async () => {
      setUser(await removeAvatar(current.avatarUrl));
    });
  }

  return (
    <SettingsGroup title="Profile photo">
      <div className="flex items-center gap-4 p-4">
        <UserAvatar avatarUrl={user.avatarUrl} username={user.username} size={72} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={uploading} onClick={() => void onChangeClick()}>
              {user.avatarUrl ? "Change photo" : "Add photo"}
            </Button>
            {user.avatarUrl && (
              <Button variant="text" disabled={uploading} onClick={() => void onRemoveClick()}>
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-on-surface-variant">
            Shown beside your name on your profile, posts, and comments.
          </p>
        </div>
      </div>
      {actionError && (
        <p className="mx-4 mb-4 rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
          {actionError}
        </p>
      )}
      {status && (
        <p className="mx-4 mb-4 rounded-m3-sm border border-outline-variant px-3 py-2 text-sm text-on-surface" role="status">
          {status}
        </p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Choose profile photo"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onFileSelected(file);
        }}
      />
    </SettingsGroup>
  );
}
