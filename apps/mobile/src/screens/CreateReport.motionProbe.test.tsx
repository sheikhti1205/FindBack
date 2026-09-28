// @vitest-environment jsdom
// TEMPORARY probe (Wave B): learn framer-motion v13 jsdom behaviour before
// implementing PhotoLightbox motion. Deleted before handoff.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatePresence, motion } from "framer-motion";
import { pageForwardVariants } from "../components/uiMotion";

afterEach(cleanup);

function Panel({ open }: { open: boolean }) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          data-testid="root"
          data-role="root"
          exit={{ pointerEvents: "none" }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
        >
          <motion.div
            data-testid="panel"
            initial={{ opacity: 0, x: -362, y: -234, scale: 0.1302 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: -362, y: -234, scale: 0.1302 }}
            transition={{ type: "tween", duration: 0.28 }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

describe("motion probe", () => {
  it("reports initial transform + exit pointerEvents", async () => {
    const { rerender } = render(<Panel open />);
    const panel = screen.getByTestId("panel");
    console.log("PROBE initial transform:", JSON.stringify(panel.style.transform));
    console.log("PROBE initial opacity:", JSON.stringify(panel.style.opacity));
    await waitFor(() => expect(panel.style.transform).toBe("none"), { timeout: 3000 }).catch(
      () => console.log("PROBE settled transform:", JSON.stringify(panel.style.transform)),
    );
    console.log("PROBE settled transform:", JSON.stringify(panel.style.transform));

    rerender(<Panel open={false} />);
    const root = screen.getByTestId("root");
    console.log("PROBE exit root pointerEvents:", JSON.stringify(root.style.pointerEvents));
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull(), { timeout: 3000 });
  });

  it("reports directional variants output", async () => {
    render(
      <motion.div
        data-testid="dir"
        variants={pageForwardVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={{ type: "tween", duration: 0.3 }}
      />,
    );
    const el = screen.getByTestId("dir");
    console.log("PROBE dir initial:", JSON.stringify(el.style.transform), JSON.stringify(el.style.opacity));
    await waitFor(() => expect(el.style.transform).toBe("none"), { timeout: 3000 }).catch(() => {});
    console.log("PROBE dir settled:", JSON.stringify(el.style.transform), JSON.stringify(el.style.opacity));
  });

  it("fake timers drive motion exits", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Panel open />);
      rerender(<Panel open={false} />);
      await vi.advanceTimersByTimeAsync(600);
      console.log("PROBE fake-timer panel present:", screen.queryByTestId("panel") !== null);
      console.log(
        "PROBE fake-timer pointerEvents:",
        JSON.stringify(screen.queryByTestId("root")?.style.pointerEvents ?? null),
      );
      expect(screen.queryByTestId("panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
