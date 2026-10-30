// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CommunityGuidelines, PrivacyPolicy, Terms } from "./Legal";

afterEach(cleanup);

function renderScreen(element: React.ReactElement) {
  render(<MemoryRouter>{element}</MemoryRouter>);
}

/**
 * Every sentence the documents used to promise, and the capability the app
 * does not have. The first draft of these documents promised ratings, report
 * deletion, report editing, chat transcripts in "protected storage" and a
 * shared report that "anyone with the link" can open. None of those shipped,
 * so the copy must not say them again — a promise the app cannot keep is the
 * failure mode this document set must not contain.
 */
const UNBUILT_CAPABILITIES: readonly { pattern: RegExp; missing: string }[] = [
  { pattern: /rate those reports|rate this report|your rating on a report/i, missing: "leaving a rating (the rating write path is revoked)" },
  { pattern: /rating you leave|can see what you rated/i, missing: "a rating that outlives the account, or a per-reader score others can see" },
  { pattern: /rate (a|this|these|that) report/i, missing: "leaving a rating" },
  { pattern: /your rating\b/i, missing: "a rating the reader is told they can still leave" },
  { pattern: /protected storage/i, missing: "chat transcripts written to protected storage (the store is in-memory)" },
  { pattern: /anyone with the link/i, missing: "opening a shared report without an account" },
  { pattern: /by using the app you accept/i, missing: "an acceptance the reader never saw" },
];

describe("legal documents", () => {
  it("distinguishes durable peer messages from ephemeral AI chat and discloses safety retention", () => {
    const { container } = render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
    const copy = container.textContent ?? "";
    expect(copy).toMatch(/private messages[^.]*stored on (?:this|your) device/i);
    expect(copy).toMatch(/not end-to-end encrypted/i);
    expect(copy).toMatch(/temporar(?:y|ily)[^.]*deliver/i);
    expect(copy).toMatch(/AI Chat[^.]*memory/i);
    expect(copy).toMatch(/90 days/);
    expect(copy).toMatch(/retain[^.]*safety|safety[^.]*retain/i);
    expect(copy).toMatch(/appeal[^.]*retain|retain[^.]*appeal/i);
  });

  it("describes existing report controls and recovery-linked ratings without promising arbitrary report ratings", () => {
    const { container } = render(<MemoryRouter><Terms /><PrivacyPolicy /></MemoryRouter>);
    const copy = container.textContent ?? "";
    expect(copy).toMatch(/edit or delete your (?:own )?report/i);
    expect(copy).toMatch(/recovery[^.]*rat(?:e|ing)/i);
    expect(copy).not.toMatch(/app does not take new ratings/i);
  });
  it("states what the reader is responsible for on a report", () => {
    renderScreen(<Terms />);
    expect(screen.getByRole("heading", { level: 1, name: "Terms of use" })).toBeTruthy();
    expect(screen.getByText(/you are responsible for what you post/i)).toBeTruthy();
  });

  it("does not promise moderation tooling the app does not have", () => {
    renderScreen(<Terms />);
    // A promise about enforcement that the app cannot keep is the failure mode
    // this document must not contain.
    expect(screen.queryByText(/we (will )?(remove|moderate|take down) any report/i)).toBeNull();
  });

  it("promises no capability the app does not have", () => {
    const { container } = render(
      <MemoryRouter>
        <Terms />
        <PrivacyPolicy />
        <CommunityGuidelines />
      </MemoryRouter>,
    );
    const text = container.textContent ?? "";
    for (const { pattern, missing } of UNBUILT_CAPABILITIES) {
      expect(text, `the copy must not promise ${missing}`).not.toMatch(pattern);
    }
  });

  it("separates device data from server data and from the cloud provider", () => {
    renderScreen(<PrivacyPolicy />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeTruthy();
    expect(screen.getByText(/stays on your phone/i)).toBeTruthy();
    expect(screen.getByText(/the provider you chose/i)).toBeTruthy();
    expect(screen.getByText(/local helpers/i)).toBeTruthy();
  });

  it("says how a reader removes their own data", () => {
    renderScreen(<PrivacyPolicy />);
    expect(screen.getByText(/delete your account/i)).toBeTruthy();
    expect(screen.getByText(/delete your own comments/i)).toBeTruthy();
  });

  it("keeps the community rules about behaviour, not about enforcement", () => {
    renderScreen(<CommunityGuidelines />);
    expect(screen.getByRole("heading", { level: 1, name: "Community guidelines" })).toBeTruthy();
    expect(screen.getByText(/search before you post/i)).toBeTruthy();
    expect(screen.getByText(/photos you took yourself/i)).toBeTruthy();
  });

  it("points every document back to Settings", () => {
    renderScreen(<Terms />);
    expect(screen.getByRole("button", { name: /back to settings/i })).toBeTruthy();
  });
});
