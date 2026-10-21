// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MarkdownView } from "./MarkdownView";
import { ReportPreviewProvider } from "./CommentReportPreviews";
import { ApiError } from "../services/session";
import type { PostItem } from "@findback/shared";
import { stripMarkdown } from "../utils/stripMarkdown";

const { fetchPost } = vi.hoisted(() => ({ fetchPost: vi.fn() }));
vi.mock("../services/posts", () => ({ fetchPost }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  fetchPost.mockReset();
});

describe("MarkdownView", () => {
  it("renders bold/italic/list/link/table/breaks", () => {
    const { container } = render(
      <MarkdownView
        text={"**bold** and *italic*\n\n- one\n- two\n\n[FindBack](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |"}
      />,
    );
    expect(container.querySelector("strong")).toBeTruthy();
    expect(container.querySelector("em")).toBeTruthy();
    expect(container.querySelector("ul")).toBeTruthy();
    expect(container.querySelector("table")).toBeTruthy();
    const link = screen.getByRole("link", { name: "FindBack" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("strips raw HTML and scripts", () => {
    const { container } = render(
      <MarkdownView text={'Hello <script>alert("x")</script> <b>raw</b> world'} />,
    );
    // Raw HTML is never parsed: no script/b elements exist (angle brackets stay inert text).
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("blocks javascript: and data: links", () => {
    render(<MarkdownView text={"[evil](javascript:alert(1)) and [d](data:text/html,hi)"} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("disables remote images", () => {
    const { container } = render(<MarkdownView text={"![alt](https://example.com/x.png)"} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shifts h1/h2/h3 down one level with three distinct styles", () => {
    const { container } = render(<MarkdownView text={"# Title\n\n## Sub\n\n### Detail"} />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Title");
    expect(container.querySelector("h3")?.textContent).toBe("Sub");
    expect(container.querySelector("h4")?.textContent).toBe("Detail");
  });

  it("demotes deeper h4–h6 headings instead of competing with the page", () => {
    const { container } = render(<MarkdownView text={"#### Deep\n\n##### Deeper"} />);
    expect(container.querySelector("h4")).toBeNull();
    expect(container.querySelector("h5")?.textContent).toBe("Deep");
    expect(container.querySelector("h6")?.textContent).toBe("Deeper");
  });

  it("wraps tables and code for horizontal scroll", () => {
    const { container } = render(
      <MarkdownView text={'```js\nconst x = 1;\n```\n\n| a |\n|---|\n| 1 |'} />,
    );
    const scrollers = container.querySelectorAll(".overflow-x-auto");
    expect(scrollers.length).toBeGreaterThanOrEqual(2);
  });

  it("breaks long unbroken words so prose never overflows", () => {
    const word = `a${"very".repeat(40)}longword`;
    const { container } = render(<MarkdownView text={word} />);
    expect(container.textContent).toContain(word);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("break-words");
  });
});

describe("MarkdownView report unfurl", () => {
  const REPORT_ID = "11111111-1111-4111-8111-111111111111";
  const ORIGIN = "https://findback.test";
  const LINK = `${ORIGIN}/r/${REPORT_ID}`;

  function referencedPost(): PostItem {
    return {
      id: REPORT_ID,
      userId: "u7",
      author: {
        id: "u7",
        username: "reporter",
        displayName: null,
        avatarUrl: null,
        emailVerified: false,
        phoneVerified: false,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      type: "FOUND",
      title: "Blue bike near the station",
      description: "",
      category: "Electronics",
      status: "OPEN",
      eventDate: "2026-09-01",
      latitude: null,
      longitude: null,
      locationLabel: null,
      youtubeUrl: null,
      attachments: [],
      likeCount: 0,
      dislikeCount: 0,
      ratingAvg: null,
      ratingCount: 0,
      commentCount: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
  }

  function renderUnfurl(text: string, unfurlReports = true) {
    return render(
      <MemoryRouter>
        <ReportPreviewProvider resetKey="u9">
          <MarkdownView text={text} unfurlReports={unfurlReports} />
        </ReportPreviewProvider>
      </MemoryRouter>,
    );
  }

  it("renders a canonical report link as the one inline card", async () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    fetchPost.mockResolvedValue(referencedPost());
    const { container } = renderUnfurl(`Found it: [report](${LINK})`);

    const card = await screen.findByTestId("report-reference");
    expect(card.getAttribute("href")).toBe(`/posts/${REPORT_ID}`);
    expect(fetchPost).toHaveBeenCalledWith(REPORT_ID);
    // The card lives inside the markdown paragraph as phrasing content only.
    expect(container.querySelector("p a")).toBeTruthy();
    expect(container.querySelector("p div, p article, p figure")).toBeNull();
  });

  it("falls through to the plain link for a wrong-origin URL", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    renderUnfurl(`[report](https://evil.test/r/${REPORT_ID})`);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`https://evil.test/r/${REPORT_ID}`);
    expect(screen.queryByTestId("report-reference")).toBeNull();
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("falls through for http and for a non-UUID id", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    const { container } = renderUnfurl(
      `[a](${ORIGIN.replace("https", "http")}/r/${REPORT_ID}) and [b](${ORIGIN}/r/not-a-uuid)`,
    );
    expect(screen.queryByTestId("report-reference")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("stays a plain link, without crashing, when the origin is not configured", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "");
    renderUnfurl(`[report](${LINK})`);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(LINK);
    expect(screen.queryByTestId("report-reference")).toBeNull();
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("renders the one unavailable card when the target is not found", async () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    fetchPost.mockRejectedValue(new ApiError("Post not found", 404));
    renderUnfurl(`[report](${LINK})`);
    expect((await screen.findByTestId("report-unavailable")).textContent).toBe("Report unavailable");
  });

  it("leaves text with no report link unchanged", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    const { container } = renderUnfurl("just a plain comment");
    expect(container.textContent).toContain("just a plain comment");
    expect(container.querySelector("a")).toBeNull();
  });

  it("stays off by default so other consumers are unaffected", () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", ORIGIN);
    renderUnfurl(`[report](${LINK})`, false);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(LINK);
    expect(screen.queryByTestId("report-reference")).toBeNull();
    expect(fetchPost).not.toHaveBeenCalled();
  });
});

describe("stripMarkdown", () => {
  it("keeps readable words, drops syntax", () => {
    expect(stripMarkdown("**Black** wallet with `zipper`")).toBe("Black wallet with zipper");
    expect(stripMarkdown("# Lost\n\n- wallet\n- keys")).toContain("wallet");
    expect(stripMarkdown("[tap here](https://x.example)")).toBe("tap here");
    expect(stripMarkdown("![photo](https://x.example/p.png)")).toBe("photo");
    expect(stripMarkdown("> quoted\n\nnormal")).toContain("normal");
  });
});

describe("MarkdownView motion (Wave E)", () => {  it("acknowledges a press on an external link, then leaves the hand-off alone", async () => {
    render(<MarkdownView text={"[FindBack](https://example.com)"} />);
    const link = screen.getByRole("link", { name: "FindBack" }) as HTMLElement;
    // Light acknowledgement only: the anchor semantics are untouched.
    fireEvent.pointerDown(link, { pointerId: 1, isPrimary: true, buttons: 1 });
    await waitFor(() => expect(link.style.opacity).not.toBe(""), { timeout: 1500 });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.pointerUp(link, { pointerId: 1, isPrimary: true });
    await waitFor(() => expect(link.style.opacity).toBe("1"), { timeout: 1500 });
  });
});

describe("MarkdownView linkMentions", () => {
  it("links @handles to the public profile with accent styling when opted in", () => {
    render(
      <MemoryRouter>
        <MarkdownView text={"thanks @alice for this"} linkMentions />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "@alice" });
    expect(link.getAttribute("href")).toBe("/u/alice");
    // W5: mention links bind the functional blue/teal family, never the accent.
    expect(link.className).toMatch(/text-mention/);
    expect(link.className).not.toMatch(/text-primary/);
  });

  it("leaves non-handles untouched", () => {
    render(
      <MemoryRouter>
        <MarkdownView text={"shout @! and a lone @ here"} linkMentions />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link")).toBeNull();
  });

  it("stays off by default so other consumers are unaffected", () => {
    render(
      <MemoryRouter>
        <MarkdownView text={"thanks @alice"} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/@alice/)).toBeTruthy();
  });
});
