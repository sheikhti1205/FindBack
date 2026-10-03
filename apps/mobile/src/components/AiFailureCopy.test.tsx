// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AiFailureCopy } from "./AiFailureCopy";

afterEach(cleanup);

describe("AiFailureCopy (WS-E failure strings)", () => {
  it("renders preparing-image copy without claiming a send", () => {
    render(<AiFailureCopy kind="preparing-image" />);
    const region = screen.getByTestId("ai-failure-preparing-image");
    expect(region.textContent).toMatch(/preparing the photo/i);
    expect(region.textContent).toMatch(/nothing has been sent/i);
  });

  it("renders loading-local-model copy as on-device only", () => {
    render(<AiFailureCopy kind="loading-local-model" />);
    const region = screen.getByTestId("ai-failure-loading-local-model");
    expect(region.textContent).toMatch(/loading the on-device model/i);
    expect(region.textContent).toMatch(/stays on this device/i);
  });

  it("renders gpu-could-not-start copy with CPU fallback", () => {
    render(<AiFailureCopy kind="gpu-could-not-start" />);
    const region = screen.getByTestId("ai-failure-gpu-could-not-start");
    expect(region.textContent).toMatch(/gpu could not start/i);
    expect(region.textContent).toMatch(/cpu fallback/i);
  });

  it("renders vision_unsupported copy", () => {
    render(<AiFailureCopy kind="vision_unsupported" />);
    const region = screen.getByTestId("ai-failure-vision_unsupported");
    expect(region.textContent).toMatch(/cannot read photos/i);
    expect(region.textContent).toMatch(/vision is not supported/i);
  });

  it("renders no-probe copy with CPU fallback", () => {
    render(<AiFailureCopy kind="no-probe" />);
    const region = screen.getByTestId("ai-failure-no-probe");
    expect(region.textContent).toMatch(/no fresh measurement/i);
    expect(region.textContent).toMatch(/cpu fallback/i);
  });
});
