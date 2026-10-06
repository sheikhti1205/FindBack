// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MAP_LOAD_TIMEOUT_MS,
  RASTER_MAX_ZOOM,
  RASTER_MIN_ZOOM,
  clampRasterZoom,
  lngLatToTile,
  nudgeCenter,
  rasterTileUrl,
  rasterTilesForCenter,
  waitForContainerLayout,
} from "./rasterTiles";

describe("rasterTiles", () => {
  it("exposes an ~8s load timeout budget", () => {
    expect(MAP_LOAD_TIMEOUT_MS).toBe(8000);
  });

  it("maps lon/lat to xyz (null island; z0 clamps to the z1 world tile)", () => {
    expect(lngLatToTile(0, 0, 0)).toEqual({ x: 1, y: 1 });
    expect(lngLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1 });
  });

  it("wraps longitude at the antimeridian", () => {
    expect(lngLatToTile(190, 0, 2)).toEqual(lngLatToTile(-170, 0, 2));
    expect(lngLatToTile(-190, 0, 2)).toEqual(lngLatToTile(170, 0, 2));
  });

  it("clamps poles to the Mercator edge rows", () => {
    expect(lngLatToTile(0, 90, 2).y).toBe(0);
    expect(lngLatToTile(0, -90, 2).y).toBe(3);
  });

  it("clamps and rounds zoom", () => {
    expect(clampRasterZoom(Number.NaN)).toBe(RASTER_MIN_ZOOM);
    expect(clampRasterZoom(-3)).toBe(RASTER_MIN_ZOOM);
    expect(clampRasterZoom(99)).toBe(RASTER_MAX_ZOOM);
    expect(clampRasterZoom(14.6)).toBe(15);
  });

  it("builds OSM tile URLs with no new dependencies", () => {
    expect(rasterTileUrl(1, 2, 3)).toBe("https://tile.openstreetmap.org/3/1/2.png");
  });

  it("returns a 3x3 grid centered on the middle tile", () => {
    const tiles = rasterTilesForCenter({ lat: 23.81, lng: 90.412 }, 15);
    expect(tiles).toHaveLength(9);
    const middle = lngLatToTile(90.412, 23.81, 15);
    expect(tiles[4]).toMatchObject({ x: middle.x, y: middle.y, z: 15 });
    expect(new Set(tiles.map((tile) => tile.url)).size).toBe(9);
    for (const tile of tiles) {
      expect(tile.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    }
  });

  it("wraps x-neighbours at the antimeridian instead of dropping columns", () => {
    const tiles = rasterTilesForCenter({ lat: 0, lng: 179.9 }, 2);
    expect(tiles).toHaveLength(9);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(4);
    }
  });

  it("repeats coordinates at minimum zoom, so render keys must carry grid position", () => {
    // z1 has only 2x2 addressable tiles: the 3x3 window MUST duplicate
    // z/x/y. Callers keying solely by coordinates get duplicate React keys.
    const tiles = rasterTilesForCenter({ lat: 23.81, lng: 90.412 }, 1);
    expect(tiles).toHaveLength(9);
    const coords = tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
    expect(new Set(coords).size).toBeLessThan(9);
    const positioned = tiles.map((tile, index) => `${tile.z}/${tile.x}/${tile.y}#${index}`);
    expect(new Set(positioned).size).toBe(9);
  });

  it("nudges the center east/north for fallback panning", () => {
    const start = { lat: 23.81, lng: 90.412 };
    expect(nudgeCenter(start, 15, 1, 0).lng).toBeGreaterThan(start.lng);
    expect(nudgeCenter(start, 15, -1, 0).lng).toBeLessThan(start.lng);
    expect(nudgeCenter(start, 15, 0, -1).lat).toBeGreaterThan(start.lat);
    expect(nudgeCenter(start, 15, 0, 1).lat).toBeLessThan(start.lat);
  });

  it("resolves immediately when the container already has size", async () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ width: 300, height: 200 }) as DOMRect;
    await waitForContainerLayout(el);
  });

  it("waits a frame and then proceeds when the container is 0x0", async () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    await waitForContainerLayout(el);
  });
});
