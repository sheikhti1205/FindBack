// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhotoLightbox } from "./PhotoLightbox";
import { resetBackInterceptors } from "./backNavigation";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
});

describe("PhotoLightbox", () => {
  it("renders nothing without a photo", () => {
    const { container } = render(<PhotoLightbox photo={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a full-size dialog labelled with photo position", () => {
    render(
      <PhotoLightbox
        photo={{ id: "p1", previewUrl: "blob:one" }}
        index={0}
        total={2}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Photo 1 of 2" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const img = screen.getByRole("img", { name: "Photo 1 of 2" }) as HTMLImageElement;
    expect(img.src).toContain("blob:one");
  });

  it("closes from the close button and from Escape", () => {
    const onClose = vi.fn();
    render(<PhotoLightbox photo={{ id: "p1", previewUrl: "blob:one" }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close photo preview/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
