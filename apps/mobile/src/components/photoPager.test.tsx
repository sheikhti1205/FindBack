// @vitest-environment jsdom
// One deliberate gesture moves at most one adjacent photo, whatever the native
// fling velocity. The clamp is the guarantee; `scroll-snap-stop` only helps.
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRef } from "react";
import { useSnapPager, type SnapPager } from "./photoPager";

afterEach(cleanup);

function Harness({ count = 4, expose }: { count?: number; expose: (pager: SnapPager) => void }) {
  const pager = useSnapPager(count);
  expose(pager);
  const track = useRef<HTMLDivElement | null>(null);
  return (
    <div
      data-testid="track"
      ref={(node) => { track.current = node; pager.trackRef.current = node; }}
      onScroll={pager.onScroll}
      style={{ overflowX: "auto" }}
    >
      {Array.from({ length: count }, (_, index) => <div key={index} style={{ width: 100 }} data-page={index} />)}
    </div>
  );
}

function mount(count = 4) {
  let pager!: SnapPager;
  render(<Harness count={count} expose={(value) => { pager = value; }} />);
  const track = screen.getByTestId("track") as HTMLDivElement;
  Object.defineProperty(track, "clientWidth", { value: 100, configurable: true });
  return { track, getPager: () => pager };
}

it("clamps a high-velocity fling to one adjacent photo", () => {
  const { track, getPager } = mount(4);
  fireEvent.pointerDown(track, { clientX: 180, clientY: 40 });
  track.scrollLeft = 300; // a fling that landed three widths away
  fireEvent.scroll(track);
  fireEvent(track, new Event("scrollend"));
  expect(getPager().active).toBe(1);
  expect(track.scrollLeft).toBe(100);
});

it("clamps backwards as well as forwards", () => {
  const { track, getPager } = mount(4);
  track.scrollLeft = 200;
  fireEvent.scroll(track);
  expect(getPager().active).toBe(2);
  fireEvent.pointerDown(track, { clientX: 20, clientY: 40 });
  track.scrollLeft = 0;
  fireEvent.scroll(track);
  fireEvent(track, new Event("scrollend"));
  expect(getPager().active).toBe(1);
  expect(track.scrollLeft).toBe(100);
});

it("leaves an ordinary single-page swipe exactly where the browser settled it", () => {
  const { track, getPager } = mount(4);
  fireEvent.pointerDown(track, { clientX: 180, clientY: 40 });
  track.scrollLeft = 100;
  fireEvent.scroll(track);
  fireEvent(track, new Event("scrollend"));
  expect(getPager().active).toBe(1);
  expect(track.scrollLeft).toBe(100);
});

it("still allows an explicit programmatic jump to any photo", () => {
  const { track, getPager } = mount(4);
  act(() => getPager().goTo(3));
  expect(getPager().active).toBe(3);
  expect(track.scrollLeft).toBe(300);
});
