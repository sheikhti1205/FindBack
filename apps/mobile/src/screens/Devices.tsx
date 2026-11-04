import { useCallback, useEffect, useRef, useState } from "react";
import { BottomSheet } from "../components/BottomSheet";
import { Button } from "../components/Button";
import { announce } from "../components/LiveRegion";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import { ApiError } from "../services/session";
import {
  describeDeviceActivity,
  describeDevicePlatform,
  listDevices,
  removeDevice,
  renameDevice,
  type SignedInDevice,
} from "../services/devices";
import { friendlyError } from "../utils/friendlyErrors";

/** One human sentence for a device operation, never raw transport text. */
function deviceError(err: unknown): string {
  if (err instanceof ApiError && err.message) return err.message;
  return friendlyError(err).message;
}

/**
 * The account's signed-in devices.
 *
 * The list is the caller's own live installations as the server reports them:
 * a friendly name, a coarse platform and recency. Identifiers, keys, sessions,
 * tokens and cursors never reach this screen. Removing another device revokes
 * its Chat and push admission there; this installation is signed out through
 * Account instead, so the row that says "This device" never offers removal.
 */
export function Devices() {
  const [rows, setRows] = useState<SignedInDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SignedInDevice | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const devices = await listDevices();
      if (!alive.current) return;
      setRows(devices);
    } catch (err) {
      if (!alive.current) return;
      setError(deviceError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeSheet = (): void => setSelected(null);

  const renamed = (deviceId: string, name: string): void => {
    setRows((current) => current?.map((row) => row.deviceId === deviceId ? { ...row, name } : row) ?? null);
    setSelected(null);
    const sentence = `This device is now called ${name}.`;
    setNotice(sentence);
    announce(sentence);
  };

  const removed = (row: SignedInDevice): void => {
    setRows((current) => current?.filter((item) => item.deviceId !== row.deviceId) ?? null);
    setSelected(null);
    const sentence = `${row.name} was removed and signed out of Chat.`;
    setNotice(sentence);
    announce(sentence);
  };

  return (
    <SettingsPage
      title="Devices"
      description="Phones, tablets and browsers signed in to your account."
      backTo="/settings"
    >
      <SettingsGroup
        title="Signed in"
        description="Removing a device signs it out of Chat and stops its messages syncing here. Your account and posts stay."
      >
        {notice ? (
          <p role="status" data-testid="devices-notice" className="px-3 py-2 text-sm text-on-surface-variant">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="devices-error" className="px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}
        {error ? (
          <button type="button" className="min-h-[44px] px-3 text-sm text-on-surface" onClick={() => void load()}>
            Retry devices
          </button>
        ) : null}

        {!error && rows === null ? (
          <p role="status" className="fb-settings-row-description">Loading your devices…</p>
        ) : null}

        {!error && rows !== null && rows.length === 0 ? (
          <p className="fb-settings-row-description">
            Devices show up here after you use Chat on them.
          </p>
        ) : null}

        {error ? null : rows?.map((row) => (
          <SettingsRow
            key={row.deviceId}
            title={row.name}
            description={`${describeDevicePlatform(row.platform)} · ${describeDeviceActivity(row.lastSeenAt)}`}
            badge={row.current ? <StatusPill tone="neutral">This device</StatusPill> : undefined}
            onClick={() => { setNotice(null); setSelected(row); }}
          />
        ))}
      </SettingsGroup>

      <DeviceSheet device={selected} onClose={closeSheet} onRenamed={renamed} onRemoved={removed} />
    </SettingsPage>
  );
}

interface DeviceSheetProps {
  device: SignedInDevice | null;
  onClose(): void;
  onRenamed(deviceId: string, name: string): void;
  onRemoved(device: SignedInDevice): void;
}

/**
 * Rename or remove one device. The destructive step is a second press inside
 * the same sheet — no browser confirm, no dialog stacked on a dialog — and the
 * current installation only offers a name plus a pointer to Account sign-out.
 */
function DeviceSheet({ device, onClose, onRenamed, onRemoved }: DeviceSheetProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"rename" | "remove" | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(device?.name ?? "");
    setArmed(false);
    setError(null);
  }, [device?.deviceId, device?.name]);

  const trimmed = draft.trim();
  const canRename = device !== null && trimmed.length >= 1 && trimmed.length <= 64 && trimmed !== device.name && busy === null;

  const submitRename = async (): Promise<void> => {
    if (!device || !canRename) return;
    setBusy("rename");
    setError(null);
    try {
      await renameDevice(device.deviceId, trimmed);
      onRenamed(device.deviceId, trimmed);
    } catch (err) {
      setError(deviceError(err));
    } finally {
      setBusy(null);
    }
  };

  const submitRemove = async (): Promise<void> => {
    if (!device || busy !== null) return;
    setBusy("remove");
    setError(null);
    try {
      await removeDevice(device.deviceId);
      onRemoved(device);
    } catch (err) {
      setError(deviceError(err));
      setArmed(false);
    } finally {
      setBusy(null);
    }
  };

  const arm = (): void => {
    setArmed(true);
    setError(null);
    if (device) announce(`Remove ${device.name}? This signs it out of Chat.`);
  };

  return (
    <BottomSheet
      open={device !== null}
      onClose={onClose}
      title={device?.name ?? "Device"}
      description="Rename this device or remove its access."
    >
      <div className="flex flex-col gap-5 pb-8">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
        >
          <label htmlFor="device-name" className="text-sm font-medium text-on-surface">
            Device name
          </label>
          <input
            id="device-name"
            type="text"
            value={draft}
            maxLength={64}
            autoComplete="off"
            disabled={busy !== null}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[48px] w-full rounded-m3-md border border-outline-variant bg-surface px-4 py-2.5 text-base text-on-surface focus:border-on-surface focus:outline-none disabled:opacity-60"
          />
          <p className="text-xs text-on-surface-variant">Shown only to you, up to 64 characters.</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === "rename"} disabled={!canRename}>
              Save name
            </Button>
            <Button variant="text" disabled={busy !== null} onClick={onClose}>
              Close
            </Button>
          </div>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-error">{error}</p>
        ) : null}

        {device?.current ? (
          <p className="text-sm text-on-surface-variant">
            This is the device you’re using. To sign it out, use Log out in Account.
          </p>
        ) : (
          <div className="border-t border-outline-variant pt-4">
            {armed ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-on-surface">
                  Remove {device?.name}? It signs out of Chat and stops receiving messages here.
                  You can sign in again on that device later.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="error" loading={busy === "remove"} onClick={() => void submitRemove()}>
                    Remove device
                  </Button>
                  <Button variant="text" disabled={busy !== null} onClick={() => setArmed(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="outline" disabled={busy !== null} onClick={arm}>
                Remove device…
              </Button>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
