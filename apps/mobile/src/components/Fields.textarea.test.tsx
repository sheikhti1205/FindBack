// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TextAreaField } from "./Fields";

afterEach(cleanup);

describe("the long-text field", () => {
  it("labels the control and describes it with the hint", () => {
    render(<TextAreaField label="Tell us what happened" hint="Up to 2000 characters." />);
    const field = screen.getByLabelText("Tell us what happened");
    expect(field.tagName.toLowerCase()).toBe("textarea");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("marks the field invalid and shows the error when there is one", () => {
    render(<TextAreaField label="Tell us what happened" error="Write something first." />);
    const field = screen.getByLabelText("Tell us what happened");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Write something first.");
  });

  it("keeps a 48dp-tall touch target on the control itself", () => {
    render(<TextAreaField label="Tell us what happened" />);
    const field = screen.getByLabelText("Tell us what happened");
    expect(field.className).toContain("min-h-[112px]");
  });
});
