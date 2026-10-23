import { describe, expect, it } from "vitest";
import { isValidPostYouTubeUrl } from "./youtubeUrl";

describe("report YouTube URL acceptance", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "http://youtube.com/watch?v=dQw4w9WgXcQ&t=12",
    "https://youtu.be/dQw4w9WgXcQ?si=share",
    "https://youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "  HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ  ",
  ])("accepts the existing server-supported format: %s", (url) => {
    expect(isValidPostYouTubeUrl(url)).toBe(true);
  });
  it.each([
    "", "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://example.invalid/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.example.invalid/watch?v=dQw4w9WgXcQ",
    "javascript:youtube.com/watch?v=dQw4w9WgXcQ",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "//youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?foo=bar&v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=short",
  ])("rejects an unsupported URL instead of queuing a server refusal: %s", (url) => {
    expect(isValidPostYouTubeUrl(url)).toBe(false);
  });
});
