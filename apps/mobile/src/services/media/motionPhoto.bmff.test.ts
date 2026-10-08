import { describe, expect, it } from "vitest";
import { hasUnsupportedMotionContainer } from "./motionPhoto";
import { ascii } from "./__fixtures__/synthetic";

describe("bounded ISOBMFF motion detection", () => {
  it.each(["heic", "avif"])("recognizes top-level mpvd in %s rather than decoding an undisclosed motion container", (brand) => {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 24); bytes.set(ascii(`ftypmif1`), 4); bytes.set(ascii(brand), 16);
    view.setUint32(24, 24); bytes.set(ascii("mpvd"), 28);
    expect(hasUnsupportedMotionContainer(bytes)).toBe(true);
  });
  it("does not interpret the letters mpvd inside mdat as a top-level box", () => {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 24); bytes.set(ascii("ftypheic"), 4);
    view.setUint32(24, 24); bytes.set(ascii("mdatmpvd"), 28);
    expect(hasUnsupportedMotionContainer(bytes)).toBe(false);
  });
});
