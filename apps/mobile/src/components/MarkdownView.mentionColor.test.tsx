// @vitest-environment jsdom
// W5 mention links: @handles bind the functional blue/teal family, never the
// user accent (accent owns principal actions/selections only).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MarkdownView } from "./MarkdownView";

afterEach(cleanup);

describe("MarkdownView mention functional color (W5)", () => {
  it("styles @handles with text-mention, not the accent text-primary", () => {
    render(
      <MemoryRouter>
        <MarkdownView text={"thanks @alice for this"} linkMentions />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "@alice" });
    expect(link.getAttribute("href")).toBe("/u/alice");
    expect(link.className).toMatch(/text-mention/);
    expect(link.className).not.toMatch(/text-primary/);
  });
});
