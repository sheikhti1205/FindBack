// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YouTubeEmbed } from "./YouTubeEmbed";

afterEach(cleanup);

describe("YouTubeEmbed link safety", () => {
  it.each([
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
    "https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQextra",
  ])("renders no embed or link for untrusted input: %s", (url) => {
    const { container } = render(<YouTubeEmbed url={url} />);
    expect(container.childElementCount).toBe(0);
  });

  it("uses a canonical watch link and fixed embed origin", async () => {
    render(<YouTubeEmbed url="https://youtu.be/dQw4w9WgXcQ?si=untrusted-tracking#fragment" />);
    expect(screen.getByRole("link", { name: "Watch on YouTube" }).getAttribute("href"))
      .toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    const player = await screen.findByTitle("Embedded YouTube video");
    expect(player.getAttribute("src")).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
  });
});
