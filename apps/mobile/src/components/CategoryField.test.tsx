// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CATEGORY_OPTIONS, CategoryField } from "./CategoryField";
import { categoryTrigger, categoryValue } from "../test-utils/reportCategory";

afterEach(cleanup);

describe("CategoryField (P3 searchable grouped sheet)", () => {
  it("exposes all 25 released canonical options for submission", () => {
    expect(CATEGORY_OPTIONS.map((o) => o.value)).toEqual([
      "Electronics",
      "Bags & Wallets",
      "Keys",
      "Documents & IDs",
      "Books & Stationery",
      "Clothing",
      "Accessories & Jewelry",
      "Other",
      "Phones & Tablets",
      "Computers & Accessories",
      "Audio & Wearables",
      "Cameras & Photography",
      "Watches & Eyewear",
      "Footwear",
      "Personal Care",
      "Tools & Equipment",
      "Office Supplies",
      "Umbrellas & Bottles",
      "Household Items",
      "Sports & Fitness",
      "Toys & Games",
      "Travel & Luggage",
      "Vehicle Accessories",
      "Medical & Health Items",
      "Pet Accessories",
    ]);
  });

  it("shows a placeholder trigger, not a native select", () => {
    const { container } = render(<CategoryField value="" onChange={() => {}} />);
    expect(container.querySelector("select")).toBeNull();
    expect(categoryTrigger()).toBeTruthy();
    expect(categoryValue()).toBe("");
  });

  it("opens the sheet with search and grouped options", () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    expect(screen.getByRole("dialog", { name: /choose a category/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/search categories/i)).toBeTruthy();
    expect(screen.getByText("Tech")).toBeTruthy();
  });

  it("commits a released category and closes the sheet", async () => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    fireEvent.click(screen.getByRole("button", { name: "Electronics" }));
    expect(onChange).toHaveBeenCalledWith("Electronics");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /choose a category/i })).toBeNull(),
    );
  });

  it("commits a cutover category and closes the sheet", async () => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    const option = screen.getByRole("button", { name: "Phones & Tablets" }) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("Phones & Tablets");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /choose a category/i })).toBeNull(),
    );
  });

  it("finds a cutover category through a synonym and commits it", () => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), {
      target: { value: "spectacles" },
    });
    const match = screen.getByRole("button", { name: "Watches & Eyewear" }) as HTMLButtonElement;
    expect(match.disabled).toBe(false);
    fireEvent.click(match);
    expect(onChange).toHaveBeenCalledWith("Watches & Eyewear");
  });

  it.each([
    ["phone", "Phones & Tablets"],
    ["laptop", "Computers & Accessories"],
    ["camera", "Cameras & Photography"],
  ] as Array<[string, string]>)("offers the specific cutover option when searching %s", (query, expected) => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), { target: { value: query } });
    const option = screen.getByRole("button", { name: expected }) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it("clears the query and recovers from zero results", () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const search = screen.getByPlaceholderText(/search categories/i);
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText(/No categories match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show all categories/i }));
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("keeps search in a fixed header outside the scrolling results", () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const header = screen.getByTestId("bottom-sheet-header");
    expect(header.contains(screen.getByPlaceholderText(/search categories/i))).toBe(true);
    // The outer sheet content must not scroll; only the results region does.
    expect(screen.getByTestId("bottom-sheet-content").style.overflowY).toBe("hidden");
    const results = screen.getByTestId("category-results");
    expect(results.className).toMatch(/overflow-y-auto/);
  });

  it("announces the result count while filtering", () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), {
      target: { value: "spectacles" },
    });
    expect(screen.getByText(/1 category/)).toBeTruthy();
  });

  it("separates groups with dividers and tints the selected row", () => {
    const { container } = render(<CategoryField value="Keys" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const sections = container.querySelectorAll("section[aria-label]");
    expect(sections.length).toBeGreaterThan(1);
    const second = sections[1];
    expect(second).toBeTruthy();
    expect(second?.className).toMatch(/border-t/);
    const selected = screen.getByRole("button", { name: "Keys" });
    expect(selected.className).toMatch(/bg-surface-container/);
    expect(selected.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks the trigger invalid and announces the error", () => {
    render(<CategoryField value="" onChange={() => {}} error="Choose a category" />);
    expect(screen.getByRole("alert").textContent).toBe("Choose a category");
    expect(categoryTrigger().getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the selected value on the trigger", () => {
    render(<CategoryField value="Keys" onChange={() => {}} />);
    expect(categoryValue()).toBe("Keys");
  });

  it("fades the results panel in when the sheet opens", async () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const results = screen.getByTestId("category-results");
    // Entrance starts hidden and settled, never mid-flight.
    expect(results.style.opacity).toBe("0");
    await waitFor(() => expect(results.style.opacity).toBe("1"));
    expect(results.style.transform === "" || results.style.transform === "none").toBe(true);
  });

  it("staggers result rows in and leaves them steady once settled", async () => {
    const { container } = render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const rows = Array.from(
      container.querySelectorAll('[data-testid="category-results"] button'),
    ) as HTMLButtonElement[];
    expect(rows.length).toBeGreaterThan(9);
    const lastRow = rows[rows.length - 1]!;
    // Queued behind the capped stagger delay while earlier rows are already moving.
    expect(lastRow.style.opacity).toBe("0");
    await waitFor(() => expect(lastRow.style.opacity).toBe("1"));
    // No endless pulse: it stays put afterwards.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lastRow.style.opacity).toBe("1");
    expect(lastRow.style.transform === "" || lastRow.style.transform === "none").toBe(true);
  });

  it("acknowledges the selected row with a persistent mark and aria-pressed", async () => {
    const { rerender } = render(<CategoryField value="Keys" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    const mark = (name: string) =>
      screen.getByRole("button", { name }).querySelector("span[aria-hidden]") as HTMLElement;

    const selected = mark("Keys");
    const other = mark("Electronics");
    expect(selected).toBeTruthy();
    expect(other).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keys" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Electronics" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The mark is always in the DOM and only its opacity/scale differ.
    expect(selected.style.opacity).toBe("1");
    expect(other.style.opacity).toBe("0");

    // Selection moves: the acknowledgement follows without a remount blink.
    rerender(<CategoryField value="Electronics" onChange={() => {}} />);
    await waitFor(() => expect(mark("Electronics").style.opacity).toBe("1"));
    await waitFor(() => expect(mark("Keys").style.opacity).toBe("0"));
    expect(screen.getByRole("button", { name: "Keys" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Electronics" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
