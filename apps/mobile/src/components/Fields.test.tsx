// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectField, TextField } from "./Fields";

afterEach(cleanup);

/** Motion settles transforms to `none` (sometimes an unset style) — both are rest. */
function isAtRest(el: HTMLElement): boolean {
  const t = el.style.transform;
  return t === "" || t === "none" || t === "translateY(0px)";
}

function translateY(el: HTMLElement): number {
  const match = el.style.transform.match(/translateY\((-?[\d.]+)px\)/);
  return match ? Number.parseFloat(match[1] ?? "0") : 0;
}

describe("Fields motion", () => {
  it("lifts the label while the field is focused and settles back on blur", async () => {
    render(<TextField label="Email" />);
    const label = screen.getByText("Email", { selector: "label" }) as HTMLElement;
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    // Resting: no travel.
    expect(isAtRest(label)).toBe(true);

    fireEvent.focus(input);
    await waitFor(() => expect(translateY(label)).toBe(-1));

    fireEvent.blur(input);
    await waitFor(() => expect(isAtRest(label)).toBe(true));
  });

  it("keeps the explicit label association when a password field is rendered", () => {
    render(<TextField label="Password" type="password" hint="At least 8 characters" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("At least 8 characters")).toBeTruthy();
  });

  it("grows a validation error open to the message's natural height and collapses it closed", async () => {
    const { rerender } = render(<TextField label="Username" hint="3–20 characters" />);
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<TextField label="Username" hint="3–20 characters" error="Username is already taken" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Username is already taken");
    // Opens from closed: starts at zero height, settles at natural height.
    expect(Number.parseFloat(alert.style.height || "0")).toBe(0);
    expect(alert.style.opacity).toBe("0");
    await waitFor(() => expect(alert.style.height).toBe("auto"));
    await waitFor(() => expect(alert.style.opacity).toBe("1"));
    // The hint leaves as the error arrives (no stacking of the two lines).
    await waitFor(() => expect(screen.queryByText("3–20 characters")).toBeNull());

    rerender(<TextField label="Username" hint="3–20 characters" />);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("3–20 characters")).toBeTruthy();
  });

  it("renders a pre-populated error already open, not mid-animation", () => {
    render(<TextField label="Username" error="Username is already taken" />);
    const alert = screen.getByRole("alert");
    expect(alert.style.opacity).toBe("1");
    expect(alert.style.height).toBe("auto");
  });

  it("keeps a long, wrapped message readable at its natural height", async () => {
    const message = "Username is already taken — pick another one that is not in use.";
    render(<TextField label="Username" error={message} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.className).toMatch(/overflow-hidden/);
    await waitFor(() => expect(alert.style.height).toBe("auto"));
  });

  it("reveals and hides the password with a toggle that crossfades its icon", async () => {
    render(<TextField label="Password" type="password" hint="At least 8 characters" />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Both glyphs are stacked; the hidden one sits back.
    const glyphs = toggle.querySelectorAll("span[aria-hidden]");
    expect(glyphs).toHaveLength(2);
    expect((glyphs[0] as HTMLElement).style.opacity).toBe("1");
    expect((glyphs[1] as HTMLElement).style.opacity).toBe("0");

    fireEvent.click(toggle);
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
    // Label association still resolves to the input, not the toggle.
    expect(screen.getByLabelText("Password")).toBe(input);
    await waitFor(() => expect((glyphs[1] as HTMLElement).style.opacity).toBe("1"));
    const hide = screen.getByRole("button", { name: /hide password/i });
    expect(hide.getAttribute("aria-pressed")).toBe("true");

    // Rapid toggles settle on the last action instead of queueing.
    fireEvent.click(hide);
    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    await waitFor(() => expect(screen.getByRole("button", { name: /show password/i })).toBeTruthy());
  });

  it("holds one live status line across availability changes instead of blinking", async () => {
    const { rerender } = render(<TextField label="Username" />);
    expect(screen.queryByRole("status")).toBeNull();

    // The status arrives after first paint and fades in from closed.
    rerender(<TextField label="Username" status="Checking availability…" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Checking availability…");
    expect(status.style.opacity).toBe("0");
    await waitFor(() => expect(status.style.opacity).toBe("1"));

    // …and the same node carries every later update (no unmount/remount blink).
    rerender(<TextField label="Username" status="Username available" />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Username available");
    expect(status.style.opacity).toBe("1");

    rerender(<TextField label="Username" status="Username already exists" />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Username already exists");

    rerender(<TextField label="Username" />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps select fields label-associated and usable after the shell rework", () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Post type"
        options={[
          { value: "LOST", label: "Lost" },
          { value: "FOUND", label: "Found" },
        ]}
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("Post type") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "FOUND" } });
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Found" })).toBeTruthy();
  });

  it("opens and lifts instantly — no tween — when reduced motion is forced", async () => {
    const ui = (error?: string) => (
      <MotionConfig reducedMotion="always">
        <TextField label="Email" hint="We never share it" error={error} />
      </MotionConfig>
    );
    const { rerender } = render(ui());
    const label = screen.getByText("Email", { selector: "label" }) as HTMLElement;
    const input = screen.getByLabelText("Email") as HTMLInputElement;

    fireEvent.focus(input);
    // Transform is positional: the first frame already sits at the target,
    // never part-way through a tween.
    const focused = await waitFor(() => {
      const y = translateY(label);
      if (y === 0) throw new Error("lift not applied yet");
      return y;
    });
    expect(focused).toBe(-1);
    fireEvent.blur(input);
    await waitFor(() => {
      if (!isAtRest(label)) throw new Error("still travelling back");
    });

    // Height is positional too: the first frame that leaves the closed
    // state is already full height, never a growing tween.
    rerender(ui("Email is already registered"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Email is already registered");
    const opened = await waitFor(() => {
      const height = alert.style.height;
      if (height === "" || height === "0px") throw new Error("still closed");
      return height;
    });
    expect(opened).toBe("auto");
    await waitFor(() => expect(alert.style.opacity).toBe("1"));
    expect(screen.queryByText("We never share it")).toBeNull();
  });
});
