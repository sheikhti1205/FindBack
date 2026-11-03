// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthShell } from "./AuthShell";
import { ThemeProvider } from "../../theme";

afterEach(cleanup);

describe("shared auth branding", () => {
  it.each([false, true])("uses only the canonical mark with illustration=%s", illustration => {
    const { container } = render(<ThemeProvider><AuthShell title="Welcome to FindBack" illustration={illustration}><p>Form content</p></AuthShell></ThemeProvider>);
    expect(screen.getByRole("heading", { name: "Welcome to FindBack" })).toBeTruthy();
    const marks = [...container.querySelectorAll("header img")];
    expect(marks).toHaveLength(illustration ? 2 : 1);
    for (const mark of marks) {
      expect(mark.getAttribute("src")).toMatch(/brand-(tile|mark)-(light|dark)/);
      expect(mark.getAttribute("alt")).toBe("");
    }
    expect(container.querySelector(".lucide-radar")).toBeNull();
  });
});
