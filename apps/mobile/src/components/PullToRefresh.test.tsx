// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PullToRefresh, type PullToRefreshHandle } from "./PullToRefresh";

describe("PullToRefresh scroll handle (WP8)", () => {
  it("exposes a writable scrollTop for feed back-nav restore", () => {
    const ref = createRef<PullToRefreshHandle>();
    render(
      <PullToRefresh ref={ref} onRefresh={vi.fn()}>
        <div style={{ height: 2000 }}>tall</div>
      </PullToRefresh>,
    );
    ref.current!.scrollTop = 350;
    expect(ref.current!.scrollTop).toBe(350);
  });
});
