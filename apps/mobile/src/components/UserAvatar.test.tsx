// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserAvatar } from "./UserAvatar";

afterEach(cleanup);

describe("UserAvatar", () => {
  it("renders the avatar image when a URL is provided", () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://example.com/a.png" username="tester" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("derives initials from the username when there is no image", () => {
    render(<UserAvatar username="tester" />);
    expect(screen.getByText("TE")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("falls back to initials when the image fails to load (never a broken image)", () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://example.com/broken.png" username="tester" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("TE")).toBeTruthy();
  });

  it("renders a generic glyph when there is no username and no image", () => {
    const { container } = render(<UserAvatar username="" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to the generic glyph when a nameless image fails", () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://example.com/x.png" username={null} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("applies the requested size in pixels", () => {
    const { container } = render(<UserAvatar username="tester" size={72} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe("72px");
    expect(root.style.height).toBe("72px");
  });

  it("is decorative (hidden from assistive tech) since names sit adjacent", () => {
    const { container } = render(<UserAvatar username="tester" />);
    expect((container.firstElementChild as HTMLElement).getAttribute("aria-hidden")).toBe("true");
  });
});
