// @vitest-environment jsdom
// TEMPORARY probe (Wave B) v2. Deleted before handoff.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnimatePresence, motion } from "framer-motion";

afterEach(cleanup);

describe("motion probe v2", () => {
  it("pointerEvents in initial/animate/style", async () => {
    function Box({ open }: { open: boolean }) {
      return (
        <AnimatePresence>
          {open ? (
            <motion.div
              data-testid="a"
              initial={{ opacity: 1, pointerEvents: "auto" as const }}
              animate={{ opacity: 1, pointerEvents: "auto" as const }}
              exit={{ opacity: 0, pointerEvents: "none" as const }}
              transition={{ duration: 0.2 }}
            />
          ) : null}
        </AnimatePresence>
      );
    }
    const { rerender } = render(<Box open />);
    const a = screen.getByTestId("a");
    console.log("V2 open pointerEvents:", JSON.stringify(a.style.pointerEvents));
    rerender(<Box open={false} />);
    console.log("V2 exit pointerEvents:", JSON.stringify(a.style.pointerEvents));
    await waitFor(() => expect(screen.queryByTestId("a")).toBeNull(), { timeout: 3000 });
  });

  it("whileTap with pointer events in jsdom", () => {
    render(<motion.button data-testid="t" whileTap={{ scale: 0.97 }}>tap</motion.button>);
    const t = screen.getByTestId("t");
    console.log("V2 before:", JSON.stringify(t.style.transform));
    fireEvent.pointerDown(t, { pointerId: 1, pointerType: "touch", isPrimary: true });
    console.log("V2 after pointerDown:", JSON.stringify(t.style.transform));
    fireEvent.pointerUp(t, { pointerId: 1, pointerType: "touch", isPrimary: true });
    console.log("V2 after pointerUp:", JSON.stringify(t.style.transform));
    console.log("V2 PointerEvent ctor:", typeof (window as unknown as Record<string, unknown>).PointerEvent);
  });

  it("layout + AnimatePresence list in jsdom", async () => {
    const items = ["a", "b", "c"];
    function List({ ids }: { ids: string[] }) {
      return (
        <div role="list">
          <AnimatePresence>
            {ids.map((id) => (
              <motion.div key={id} role="listitem" layout data-testid={`i-${id}`}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.15 }}
              >
                {id}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      );
    }
    const { rerender } = render(<List ids={items} />);
    console.log("V2 item transform:", JSON.stringify(screen.getByTestId("i-b").style.transform));
    rerender(<List ids={["b", "c"]} />);
    const exiting = screen.getByTestId("i-a");
    console.log("V2 exiting present immediately:", exiting !== null, JSON.stringify(exiting.style.opacity));
    await waitFor(() => expect(screen.queryByTestId("i-a")).toBeNull(), { timeout: 3000 });
    console.log("V2 after exit, remaining:", screen.getByTestId("i-b").textContent);
  });

  it("directional variants crossfade", async () => {
    const forward = {
      hidden: { opacity: 0, x: 16 },
      visible: { opacity: 1, x: 0 },
      exit: { opacity: 0, x: -12 },
    };
    function Carousel({ id }: { id: string }) {
      return (
        <AnimatePresence initial={false}>
          <motion.div key={id} data-testid={`c-${id}`} variants={forward}
            initial="hidden" animate="visible" exit="exit"
            transition={{ duration: 0.22 }} />
        </AnimatePresence>
      );
    }
    const { rerender } = render(<Carousel id="one" />);
    const one = screen.getByTestId("c-one");
    console.log("V2 carousel initial:", JSON.stringify(one.style.transform), JSON.stringify(one.style.opacity));
    rerender(<Carousel id="two" />);
    console.log("V2 both present:", screen.queryByTestId("c-one") !== null, screen.queryByTestId("c-two") !== null);
    const two = screen.getByTestId("c-two");
    console.log("V2 incoming initial:", JSON.stringify(two.style.transform), JSON.stringify(two.style.opacity));
    await waitFor(() => expect(screen.queryByTestId("c-one")).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(two.style.opacity).toBe("1"), { timeout: 3000 });
    console.log("V2 settled:", JSON.stringify(two.style.transform));
  });
});
