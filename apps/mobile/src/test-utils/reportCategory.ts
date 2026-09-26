import { expect } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

const PLACEHOLDER = "Choose a category";

/** The custom category trigger (replaces the old native select). */
export function categoryTrigger(): HTMLElement {
  return screen.getByTestId("category-trigger");
}

/** Current committed category string, or "" when nothing is selected. */
export function categoryValue(): string {
  const text = categoryTrigger().textContent?.trim() ?? "";
  return text === PLACEHOLDER ? "" : text;
}

/**
 * Drive the searchable category sheet the way a user does: open the trigger,
 * tap the canonical option, and wait for the sheet to fully unmount.
 */
export async function chooseCategory(canonical: string): Promise<void> {
  fireEvent.click(categoryTrigger());
  fireEvent.click(screen.getByRole("button", { name: canonical }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /choose a category/i })).toBeNull(),
  );
}
