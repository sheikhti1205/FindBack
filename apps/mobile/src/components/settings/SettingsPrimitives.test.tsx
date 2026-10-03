// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { Palette } from "lucide-react";
import { useState } from "react";
import {
  SettingsPage, SettingsGroup, SettingsRow, SettingIconTile, SettingsSearch,
  PreferenceSwitchRow, ThemeCard, AccentSwatch, StatusPill, AdvancedDisclosure,
} from "./index";

afterEach(cleanup);

describe("settings foundation semantics", () => {
  it("renders a page heading, grouped rows, and focuses the heading on entry", () => {
    render(<MemoryRouter><SettingsPage title="Settings">
      <SettingsGroup title="Preferences" description="Make FindBack yours">
        <SettingsRow title="Appearance" description="Theme and color" route="/settings/appearance" icon={Palette} iconTone="lavender" value="System" />
      </SettingsGroup>
    </SettingsPage></MemoryRouter>);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Settings" }));
    expect(screen.getByRole("region", { name: "Preferences" })).toBeTruthy();
    const row = screen.getByRole("link", { name: "Appearance" });
    expect(row.getAttribute("href")).toBe("/settings/appearance");
    expect(row.getAttribute("aria-describedby")).toBeTruthy();
    expect(row.querySelectorAll("button,a,input").length).toBe(0);
  });

  it("offers a history-aware back control when requested", () => {
    render(<MemoryRouter><SettingsPage title="Appearance" backTo="/settings" backLabel="Back to Settings">Content</SettingsPage></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Back to Settings" })).toBeTruthy();
  });

  it("disables action and route rows without nesting interactive controls", () => {
    const click = vi.fn();
    render(<MemoryRouter>
      <SettingsRow title="Reset" onClick={click} disabled />
      <SettingsRow title="Unavailable" route="/future" disabled />
      <SettingsRow title="Version" value="0.4" />
    </MemoryRouter>);
    act(() => screen.getByRole("button", { name: "Reset" }).click());
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Unavailable").closest("[aria-disabled]")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("labels a switch separately from its description and updates its state", () => {
    function Demo() {
      const [checked, onChange] = useState(false);
      return <PreferenceSwitchRow title="High quality photos" description="Uses more storage" checked={checked} onChange={onChange} />;
    }
    render(<Demo />);
    const control = screen.getByRole("switch", { name: "High quality photos" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(document.getElementById(control.getAttribute("aria-describedby")!)?.textContent).toBe("Uses more storage");
    act(() => control.click());
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.querySelectorAll("button,input")).toHaveLength(0);
  });

  it("disables switches", () => {
    const change = vi.fn();
    render(<PreferenceSwitchRow title="Notifications" checked={false} onChange={change} disabled />);
    act(() => screen.getByRole("switch", { name: "Notifications" }).click());
    expect(change).not.toHaveBeenCalled();
  });

  it("uses named native radios for theme cards and accent swatches", () => {
    const theme = vi.fn();
    const accent = vi.fn();
    render(<>
      <fieldset><legend>Theme</legend>
        <ThemeCard name="theme" value="light" checked onChange={theme} />
        <ThemeCard name="theme" value="amoled" checked={false} onChange={theme} />
      </fieldset>
      <fieldset><legend>Accent</legend>
        <AccentSwatch name="accent" accent="emerald" checked onChange={accent} />
        <AccentSwatch name="accent" accent="blue" checked={false} onChange={accent} />
      </fieldset>
    </>);
    const amoled = screen.getByRole("radio", { name: "AMOLED" }) as HTMLInputElement;
    expect(amoled.tagName).toBe("INPUT");
    expect(amoled.name).toBe("theme");
    fireEvent.click(amoled);
    expect(theme).toHaveBeenCalledWith("amoled");
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    expect(accent).toHaveBeenCalledWith("blue");
    expect(screen.getByRole("radio", { name: "Emerald" }).getAttribute("name")).toBe("accent");
  });

  it("search has a real label, announces count, lists normal links, and clears with focus retained", () => {
    function Demo() {
      const [query, onQueryChange] = useState("");
      return <SettingsSearch query={query} onQueryChange={onQueryChange} results={query ? [{ id: "appearance", title: "Appearance", route: "/settings/appearance" }] : []} />;
    }
    render(<MemoryRouter><Demo /></MemoryRouter>);
    const input = screen.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "theme" } });
    expect(input.value).toBe("theme");
    expect(screen.getByRole("status").textContent).toContain("1 setting");
    expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("provides a readable empty search result", () => {
    render(<SettingsSearch query="nonexistent" onQueryChange={() => {}} results={[]} />);
    expect(screen.getByRole("status").textContent).toContain("No settings found");
  });

  it("icon tiles are decorative and disclosure/status retain visible words", () => {
    render(<><SettingIconTile icon={Palette} tone="lavender" />
      <StatusPill tone="success">Ready</StatusPill>
      <AdvancedDisclosure title="Technical details"><p>Version 0.4</p></AdvancedDisclosure>
    </>);
    expect(document.querySelector(".fb-setting-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Technical details").tagName).toBe("SUMMARY");
  });
});
