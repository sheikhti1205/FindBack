// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button";

afterEach(cleanup);

describe("Button motion pass", () => {
  it("renders children and stays enabled by default", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("crossfades a spinner in while loading and blocks interaction", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The spinner is decorative; the accessible name stays "Save".
    const spinner = button.querySelector('[data-testid="button-spinner"]');
    expect(spinner).toBeTruthy();
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
  });
});
