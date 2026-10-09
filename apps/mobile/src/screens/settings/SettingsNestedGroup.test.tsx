// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { Image } from "lucide-react";
import { SettingsRow } from "../../components/settings";
import { SettingsNestedGroup } from "./SettingsNestedGroup";

afterEach(cleanup);

function renderGroup(open = false) {
  render(
    <MemoryRouter>
      <SettingsNestedGroup
        title="Advanced"
        description="Uploads and troubleshooting."
        icon={Image}
        iconTone="media"
        defaultOpen={open}
      >
        <SettingsRow title="Media & uploads" route="/settings/media" />
        <SettingsRow title="Diagnostics" route="/settings/diagnostics" />
      </SettingsNestedGroup>
    </MemoryRouter>,
  );
}

describe("SettingsNestedGroup", () => {
  it("renders a keyboard-focusable summary with the group title", () => {
    renderGroup();
    const summary = document.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toContain("Advanced");
    expect(summary!.textContent).toContain("Uploads and troubleshooting.");
  });

  it("starts closed and toggles open on summary click", () => {
    renderGroup();
    const details = document.querySelector("details")!;
    expect(details.hasAttribute("open")).toBe(false);
    act(() => {
      document.querySelector("summary")!.click();
    });
    expect(document.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("keeps every nested destination reachable with its real route", () => {
    renderGroup(true);
    expect(screen.getByRole("link", { name: "Media & uploads" }).getAttribute("href")).toBe(
      "/settings/media",
    );
    expect(screen.getByRole("link", { name: "Diagnostics" }).getAttribute("href")).toBe(
      "/settings/diagnostics",
    );
  });

  it("never nests links inside the summary control", () => {
    renderGroup(true);
    const summary = document.querySelector("summary")!;
    expect(summary.querySelectorAll("a,button,input").length).toBe(0);
  });
});
