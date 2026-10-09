// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "amoled", "light");
});

describe("BrandMark (LOGO2 canonical mark)", () => {
  it.each([24, 32, 48])("renders at %spx with matching width/height", (size) => {
    render(<BrandMark size={size} />);
    const img = screen.getByRole("img", { name: "FindBack" });
    expect(img.getAttribute("width")).toBe(String(size));
    expect(img.getAttribute("height")).toBe(String(size));
  });

  it("auto-resolves to the dark (black-glyph) asset on light surfaces", () => {
    document.documentElement.classList.add("light");
    render(<BrandMark size={32} />);
    const img = screen.getByRole("img", { name: "FindBack" });
    expect(img.getAttribute("src")).toContain("brand-mark-dark");
  });

  it("auto-resolves to the light (white-glyph) asset on dark surfaces", () => {
    document.documentElement.classList.add("dark");
    render(<BrandMark size={32} />);
    const img = screen.getByRole("img", { name: "FindBack" });
    expect(img.getAttribute("src")).toContain("brand-mark-light");
  });

  it("auto-resolves to the light asset under true-black (.amoled)", () => {
    document.documentElement.classList.add("dark", "amoled");
    render(<BrandMark size={32} />);
    expect(screen.getByRole("img", { name: "FindBack" }).getAttribute("src")).toContain(
      "brand-mark-light",
    );
  });

  it("explicit variant wins over the resolved theme", () => {
    document.documentElement.classList.add("dark");
    render(<BrandMark size={32} variant="dark" />);
    expect(screen.getByRole("img", { name: "FindBack" }).getAttribute("src")).toContain(
      "brand-mark-dark",
    );
  });

  it("uses the light (white-glyph) asset when asked", () => {
    render(<BrandMark size={32} variant="light" />);
    const img = screen.getByRole("img", { name: "FindBack" });
    expect(img.getAttribute("src")).toContain("brand-mark-light");
  });

  it("keeps light/dark variants distinct so the mark stays visible in both modes", () => {
    const { unmount } = render(<BrandMark size={32} variant="dark" />);
    const darkSrc = screen.getByRole("img", { name: "FindBack" }).getAttribute("src");
    unmount();
    cleanup();
    render(<BrandMark size={32} variant="light" />);
    const lightSrc = screen.getByRole("img", { name: "FindBack" }).getAttribute("src");
    expect(darkSrc).toBeTruthy();
    expect(lightSrc).toBeTruthy();
    expect(darkSrc).not.toBe(lightSrc);
  });
});
