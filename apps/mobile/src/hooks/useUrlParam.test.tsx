// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { useUrlParam } from "./useUrlParam";

function Probe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function Harness({ storageKey }: { storageKey: string }) {
  const [value, setValue] = useUrlParam(storageKey);
  return (
    <div>
      <div data-testid="value">{value}</div>
      <button type="button" onClick={() => setValue("LOST")}>
        set
      </button>
      <button type="button" onClick={() => setValue("")}>
        clear
      </button>
      <Probe />
    </div>
  );
}

function renderHarness(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Harness storageKey="type" />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("useUrlParam (WP7 #7)", () => {
  it("starts empty with a clean URL", () => {
    renderHarness("/");
    expect(screen.getByTestId("value").textContent).toBe("");
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("restores the value from the URL on mount", () => {
    renderHarness("/?type=FOUND");
    expect(screen.getByTestId("value").textContent).toBe("FOUND");
  });

  it("writes edits back to the URL", () => {
    renderHarness("/");
    fireEvent.click(screen.getByText("set"));
    expect(screen.getByTestId("value").textContent).toBe("LOST");
    expect(screen.getByTestId("location").textContent).toBe("/?type=LOST");
  });

  it("removes the param when cleared", () => {
    renderHarness("/?type=FOUND");
    fireEvent.click(screen.getByText("clear"));
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("preserves unrelated params", () => {
    renderHarness("/?q=wallet");
    fireEvent.click(screen.getByText("set"));
    expect(screen.getByTestId("location").textContent).toBe("/?q=wallet&type=LOST");
  });
});
