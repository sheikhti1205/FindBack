// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createNativeMap, type NativeMapHandle } from "./nativeMap";

function fakeHandle(): NativeMapHandle & {
  taps: Array<(pick: { center: { lat: number; lng: number } }) => void>;
  dragEnds: Array<(pick: { center: { lat: number; lng: number } }) => void>;
  idles: Array<(center: { lat: number; lng: number }, zoom: number) => void>;
  markers: Array<{ lat: number; lng: number }>;
  cameras: Array<{ center: { lat: number; lng: number }; zoom?: number }>;
  destroyed: boolean;
} {
  const taps: Array<(pick: { center: { lat: number; lng: number } }) => void> = [];
  const dragEnds: Array<(pick: { center: { lat: number; lng: number } }) => void> = [];
  const idles: Array<(center: { lat: number; lng: number }, zoom: number) => void> = [];
  return {
    taps,
    dragEnds,
    idles,
    markers: [],
    cameras: [],
    destroyed: false,
    async setMarker(center) {
      this.markers.push(center);
    },
    async setCamera(center, zoom) {
      this.cameras.push({ center, zoom });
    },
    async onMapTap(callback) {
      taps.push(callback);
    },
    async onMarkerDragEnd(callback) {
      dragEnds.push(callback);
    },
    async onCameraIdle(callback) {
      idles.push(callback);
    },
    async destroy() {
      this.destroyed = true;
    },
  };
}

describe("nativeMap seam", () => {
  it("refuses to create without a key (callers fail closed before this)", async () => {
    const loader = { create: vi.fn() };
    await expect(
      createNativeMap(document.createElement("div"), {
        apiKey: "   ",
        center: { lat: 0, lng: 0 },
        zoom: 1,
        loader,
      }),
    ).rejects.toThrow(/api key/i);
    expect(loader.create).not.toHaveBeenCalled();
  });

  it("delegates marker/camera/listener/destroy calls to the loaded handle", async () => {
    const handle = fakeHandle();
    const loader = { create: vi.fn().mockResolvedValue(handle) };
    const element = document.createElement("div");
    const created = await createNativeMap(element, {
      apiKey: "key",
      center: { lat: 23.8, lng: 90.4 },
      zoom: 15,
      draggable: true,
      loader,
    });
    expect(loader.create).toHaveBeenCalledWith(
      element,
      expect.objectContaining({ apiKey: "key", draggable: true }),
    );
    await created.setMarker({ lat: 1, lng: 2 });
    await created.setCamera({ lat: 3, lng: 4 }, 12);
    const onTap = vi.fn();
    const onDragEnd = vi.fn();
    const onIdle = vi.fn();
    await created.onMapTap(onTap);
    await created.onMarkerDragEnd(onDragEnd);
    await created.onCameraIdle(onIdle);
    handle.taps[0]?.({ center: { lat: 5, lng: 6 } });
    handle.dragEnds[0]?.({ center: { lat: 5.5, lng: 6.5 } });
    handle.idles[0]?.({ lat: 7, lng: 8 }, 14);
    expect(handle.markers).toEqual([{ lat: 1, lng: 2 }]);
    expect(handle.cameras).toEqual([{ center: { lat: 3, lng: 4 }, zoom: 12 }]);
    expect(onTap).toHaveBeenCalledWith({ center: { lat: 5, lng: 6 } });
    expect(onDragEnd).toHaveBeenCalledWith({ center: { lat: 5.5, lng: 6.5 } });
    expect(onIdle).toHaveBeenCalledWith({ lat: 7, lng: 8 }, 14);
    await created.destroy();
    expect(handle.destroyed).toBe(true);
  });
});
