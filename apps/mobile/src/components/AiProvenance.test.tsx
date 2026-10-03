// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiProvenance } from "./AiProvenance";

afterEach(cleanup);

describe("AiProvenance (WS-E provenance badge)", () => {
  it("renders Local scope with model and backend in the badge", () => {
    render(
      <AiProvenance
        scope="Local"
        model="smolvlm2-500m"
        backend="cpu"
        requested="gpu"
        actual="cpu"
        reason="no-evidence"
      />,
    );
    const badge = screen.getByTestId("ai-provenance-badge");
    expect(badge.textContent).toMatch(/local/i);
    expect(badge.textContent).toMatch(/smolvlm2-500m/);
    expect(badge.textContent).toMatch(/cpu/);
  });

  it("renders Cloud scope badge", () => {
    render(
      <AiProvenance scope="Cloud" model="openrouter/free" backend="cloud" />,
    );
    expect(screen.getByTestId("ai-provenance-badge").textContent).toMatch(
      /cloud/i,
    );
  });

  it("tappable badge reveals requested, actual, and reason", () => {
    render(
      <AiProvenance
        scope="Local"
        model="smolvlm2-500m"
        backend="cpu"
        requested="gpu"
        actual="cpu"
        reason="no-evidence"
      />,
    );
    expect(screen.queryByTestId("ai-provenance-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("ai-provenance-badge"));
    const detail = screen.getByTestId("ai-provenance-detail");
    expect(detail.textContent).toMatch(/gpu/);
    expect(screen.getByTestId("ai-provenance-requested").textContent).toMatch(
      /gpu/,
    );
    expect(screen.getByTestId("ai-provenance-actual").textContent).toMatch(
      /cpu/,
    );
    expect(screen.getByTestId("ai-provenance-reason").textContent).toMatch(
      /no-evidence/,
    );
  });

  it("toggles the detail closed on a second tap", () => {
    render(
      <AiProvenance scope="Local" model="m" backend="cpu" requested="gpu" />,
    );
    fireEvent.click(screen.getByTestId("ai-provenance-badge"));
    expect(screen.getByTestId("ai-provenance-detail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ai-provenance-badge"));
    expect(screen.queryByTestId("ai-provenance-detail")).toBeNull();
  });
});
