// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhotoLightbox } from "./PhotoLightbox";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function photo(id: string) {
  return { id, previewUrl: `blob:${id}` };
}

describe("PhotoLightbox touch swipe", () => {
  it("swipe left goes next, swipe right goes previous", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <PhotoLightbox
        photo={photo("p1")}
        index={0}
        total={3}
        onClose={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    const stage = screen.getByTestId("lightbox-stage");
    fireEvent.touchStart(stage, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 90, clientY: 205 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 90, clientY: 205 }] });
    expect(onNext).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(stage, { touches: [{ clientX: 90, clientY: 200 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 220, clientY: 202 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 220, clientY: 202 }] });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("ignores vertical and small drags, keeps arrows and keyboard", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <PhotoLightbox
        photo={photo("p1")}
        index={0}
        total={2}
        onClose={vi.fn()}
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    const stage = screen.getByTestId("lightbox-stage");
    fireEvent.touchStart(stage, { touches: [{ clientX: 150, clientY: 60 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 145, clientY: 260 }] });
    fireEvent.touchStart(stage, { touches: [{ clientX: 150, clientY: 200 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 158, clientY: 201 }] });
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });
});
