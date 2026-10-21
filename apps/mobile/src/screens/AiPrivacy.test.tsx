// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AiPrivacy } from "./AiPrivacy";

describe("AiPrivacy consumer disclosure", () => {
  afterEach(cleanup);

  it("describes the cloud chat and the on-device helpers without the retired mode switch", () => {
    render(
      <MemoryRouter>
        <AiPrivacy />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/ai & privacy/i);
    expect(screen.getByText(/provider you pick/i)).toBeTruthy();
    expect(screen.getByText(/stay on the device/i)).toBeTruthy();
    const text = (document.body.textContent ?? "").toLowerCase();
    // The Automatic/On-device-only/Cloud-only switch no longer exists in the
    // consumer surface, so the disclosure must not describe it.
    expect(text).not.toContain("automatic");
    expect(text).not.toContain("on-device-only");
    expect(text).not.toContain("cloud-only");
  });

  it("points at the provider destination the way the app names it", () => {
    render(
      <MemoryRouter>
        <AiPrivacy />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("href")).toBe(
      "/settings/ai/connections",
    );
  });
});
