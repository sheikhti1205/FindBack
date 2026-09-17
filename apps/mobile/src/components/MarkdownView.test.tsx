// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarkdownView } from "./MarkdownView";
import { stripMarkdown } from "../utils/stripMarkdown";

afterEach(cleanup);

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

  it("remaps h1/h2 down the hierarchy", () => {
    const { container } = render(<MarkdownView text={"# Title\n\n## Sub"} />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("h3")).toBeTruthy();
    expect(container.querySelector("h4")).toBeTruthy();
  });

  it("wraps tables and code for horizontal scroll", () => {
    const { container } = render(
      <MarkdownView text={'```js\nconst x = 1;\n```\n\n| a |\n|---|\n| 1 |'} />,
    );
    const scrollers = container.querySelectorAll(".overflow-x-auto");
    expect(scrollers.length).toBeGreaterThanOrEqual(2);
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
