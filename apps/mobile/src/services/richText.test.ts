import { describe, expect, it } from "vitest";
import {
  fromMarkdown,
  isSafeRichTextHref,
  toMarkdown,
  type RichTextDocument,
} from "./richText";

function roundTrip(doc: RichTextDocument): RichTextDocument {
  return fromMarkdown(toMarkdown(doc));
}

describe("richText round-trip fidelity", () => {
  it("preserves bold/italic/link runs in a paragraph", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [
            { type: "InlineText", text: "Lost " },
            { type: "Bold", text: "black wallet" },
            { type: "InlineText", text: " near " },
            { type: "Italic", text: "Central Park" },
            { type: "InlineText", text: " — see " },
            { type: "Link", href: "https://example.com/photo", text: "photo" },
          ],
        },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("preserves heading levels", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        { type: "Heading", level: 1, runs: [{ type: "InlineText", text: "Lost wallet" }] },
        { type: "Heading", level: 2, runs: [{ type: "InlineText", text: "Details" }] },
        { type: "Heading", level: 3, runs: [{ type: "Bold", text: "Reward" }] },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("preserves bullet lists", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "BulletList",
          items: [
            [{ type: "InlineText", text: "black leather" }],
            [
              { type: "Bold", text: "zipper" },
              { type: "InlineText", text: " pocket" },
            ],
          ],
        },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("preserves ordered lists, numbering and adjacent list kinds across drafts", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        { type: "OrderedList", start: 3, items: [[{ type: "Bold", text: "one" }], [{ type: "InlineText", text: "two" }]] },
        { type: "BulletList", items: [[{ type: "Italic", text: "three" }]] },
        { type: "OrderedList", start: 1, items: [[{ type: "InlineText", text: "four" }]] },
      ],
    };
    expect(toMarkdown(doc)).toBe("3. **one**\n4. two\n\n- *three*\n\n1. four");
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("round trips bold and italic with and without a safe link", () => {
    const markdown = "***black*** **[badge](https://example.com/b)** *[map](https://example.com/m)* ***[case](https://example.com/c)***";
    const doc = fromMarkdown(markdown);
    expect(doc.blocks[0]).toEqual({
      type: "Paragraph",
      runs: [
        { type: "BoldItalic", text: "black" },
        { type: "InlineText", text: " " },
        { type: "BoldLink", text: "badge", href: "https://example.com/b" },
        { type: "InlineText", text: " " },
        { type: "ItalicLink", text: "map", href: "https://example.com/m" },
        { type: "InlineText", text: " " },
        { type: "BoldItalicLink", text: "case", href: "https://example.com/c" },
      ],
    });
    expect(toMarkdown(doc)).toBe(markdown);
  });

  it("keeps bold+italic while stripping an unsafe nested link", () => {
    const doc = fromMarkdown("***[case](javascript:alert(1))***");
    expect(doc.blocks[0]).toEqual({ type: "Paragraph", runs: [{ type: "BoldItalic", text: "case" }] });
    expect(toMarkdown(doc)).toBe("***case***");
  });

  it("preserves quotes", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "Quote",
          runs: [
            { type: "InlineText", text: "Guard said " },
            { type: "Italic", text: "it was found Tuesday" },
          ],
        },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("preserves a mixed multi-block document", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        { type: "Heading", level: 1, runs: [{ type: "InlineText", text: "Lost keys" }] },
        {
          type: "Paragraph",
          runs: [{ type: "InlineText", text: "Silver keychain with two keys." }],
        },
        {
          type: "BulletList",
          items: [[{ type: "InlineText", text: "lobby" }], [{ type: "InlineText", text: "gym" }]],
        },
        { type: "Quote", runs: [{ type: "InlineText", text: "Ask at reception." }] },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("degrades unsupported blocks to paragraphs, never crashes", () => {
    const doc = fromMarkdown(
      [
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "![photo](https://example.com/p.png)",
        "",
        "#### too deep",
        "",
         "1. first",
         "2. second",
        "",
        "---",
        "",
        "<div>raw block</div>",
      ].join("\n"),
    );
     expect(doc.blocks.some((block) => block.type === "OrderedList")).toBe(true);
    const text = doc.blocks.flatMap((block) => block.type === "Paragraph" ? block.runs : block.type === "OrderedList" ? block.items.flat() : []).map((run) => run.text).join("\n");
    expect(text).toContain("photo");
    expect(text).toContain("too deep");
    expect(text).toContain("first");
  });

  it("never throws on garbage input", () => {
    for (const bad of ["", "   \n\n  ", "**unclosed", "[x](", "](y)", ">", "#", "- ", "(((***"]) {
      expect(() => fromMarkdown(bad)).not.toThrow();
      expect(() => toMarkdown(fromMarkdown(bad))).not.toThrow();
    }
    expect(fromMarkdown("").blocks.length).toBeGreaterThan(0);
  });
});

describe("richText link-scheme security", () => {
  it("blocks javascript: links, keeps the display text", () => {
    const doc = fromMarkdown("[evil](javascript:alert(1))");
    const runs = doc.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : []));
    expect(runs.some((r) => r.type === "Link")).toBe(false);
    expect(runs.map((r) => r.text).join("")).toContain("evil");
    expect(toMarkdown(doc)).not.toContain("javascript:");
  });

  it("blocks data: and file: links", () => {
    for (const md of ["[d](data:text/html,hi)", "[f](file:///etc/passwd)", "[v](vbscript:msgbox(1))"]) {
      const doc = fromMarkdown(md);
      const runs = doc.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : []));
      expect(runs.some((r) => r.type === "Link")).toBe(false);
    }
    expect(isSafeRichTextHref("data:text/html,hi")).toBe(false);
    expect(isSafeRichTextHref("file:///etc/passwd")).toBe(false);
  });

  it("blocks scheme tricks: case, whitespace, control chars", () => {
    for (const href of [
      "JaVaScRiPt:alert(1)",
      "   javascript:alert(1)",
      "java\tscript:alert(1)",
      "javascript&#58;alert(1)",
    ]) {
      expect(isSafeRichTextHref(href)).toBe(false);
    }
  });

  it("allows safe http(s) links through the round-trip", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [{ type: "Link", href: "https://example.com/a?b=c", text: "listing" }],
        },
      ],
    };
    const back = roundTrip(doc);
    expect(back.blocks[0]).toEqual(doc.blocks[0]);
    const http = fromMarkdown("[h](http://example.com)");
    expect(
      http.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : [] as never[])).some((r) => r.type === "Link"),
    ).toBe(true);
  });

  it("never emits an unsafe link from toMarkdown, even for a hostile doc", () => {
    const hostile = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [{ type: "Link", href: "javascript:alert(1)", text: "click" }],
        },
      ],
    } as unknown as RichTextDocument;
    const md = toMarkdown(hostile);
    expect(md).not.toContain("javascript:");
    expect(md).toContain("click");
    expect(fromMarkdown(md).blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : [] as never[])).some((r) => r.type === "Link" && /javascript:/i.test(r.href))).toBe(false);
  });

  it("treats arbitrary HTML as inert text, never executable markup", () => {
    const doc = fromMarkdown('Hello <script>alert("x")</script> <b>raw</b> <img src=x onerror=y>');
    const text = doc.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : [] as never[])).map((r) => (r as { text: string }).text).join("");
    expect(text).toContain("Hello");
    const md = toMarkdown(doc);
    expect(md).not.toMatch(/<script|<img|<b>/i);
  });

  it("malformed links cannot break rendering or forge nodes", () => {
    for (const md of [
      "[text](javascript:alert(1)",
      "[text]()",
      "[text](   )",
      "[unclosed",
      "[](https://example.com)",
      "[[nested]](https://example.com)",
      "[x](https://example.com \"ti()tle\")",
    ]) {
      const doc = fromMarkdown(md);
      expect(() => toMarkdown(doc)).not.toThrow();
      for (const block of doc.blocks) {
        if (block.type !== "Paragraph") continue;
        for (const run of block.runs) {
          if (run.type === "Link") expect(isSafeRichTextHref(run.href)).toBe(true);
        }
      }
    }
  });

  it("markdown metacharacters in plain text cannot forge links or headings", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [{ type: "InlineText", text: "[x](javascript:alert(1)) # not a heading" }],
        },
      ],
    };
    const back = roundTrip(doc);
    expect(back).toEqual(doc);
    expect(
      back.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : [] as never[])).some((r) => r.type === "Link"),
    ).toBe(false);
  });
});

describe("richText combined emphasis links", () => {
  it("preserves bold+link and italic+link runs", () => {
    const doc: RichTextDocument = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [
            { type: "BoldLink", href: "https://example.com/photo", text: "photo" },
            { type: "InlineText", text: " and " },
            { type: "ItalicLink", href: "https://example.com/map", text: "map" },
          ],
        },
      ],
    };
    expect(toMarkdown(doc)).toBe("**[photo](https://example.com/photo)** and *[map](https://example.com/map)*");
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("keeps display text when emphasis wraps an unsafe link", () => {
    const doc = fromMarkdown("**[evil](javascript:alert(1))**");
    const runs = doc.blocks.flatMap((b) => (b.type === "Paragraph" ? b.runs : []));
    expect(runs.some((r) => r.type === "Link" || r.type === "BoldLink" || r.type === "ItalicLink")).toBe(false);
    expect(runs.map((r) => r.text).join("")).toContain("evil");
    expect(toMarkdown(doc)).toBe("**evil**");
  });

  it("never emits an unsafe link from a hostile combined run", () => {
    const hostile = {
      v: 1,
      blocks: [
        {
          type: "Paragraph",
          runs: [
            { type: "BoldLink", href: "javascript:alert(1)", text: "click" },
            { type: "ItalicLink", href: "data:text/html,hi", text: "tap" },
          ],
        },
      ],
    } as unknown as RichTextDocument;
    const md = toMarkdown(hostile);
    expect(md).not.toMatch(/javascript:|data:/i);
    expect(md).toBe("**click***tap*");
    expect(roundTrip(fromMarkdown(md))).toEqual(fromMarkdown(md));
  });
});
