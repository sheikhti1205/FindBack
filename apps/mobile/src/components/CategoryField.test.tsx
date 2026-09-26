// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CATEGORY_OPTIONS, CategoryField } from "./CategoryField";
import { categoryTrigger, categoryValue } from "../test-utils/reportCategory";

afterEach(cleanup);

describe("CategoryField (P3 searchable grouped sheet)", () => {
  it("exposes only the released canonical options for submission", () => {
    expect(CATEGORY_OPTIONS.map((o) => o.value)).toEqual([
      "Electronics",
      "Bags & Wallets",
      "Keys",
      "Documents & IDs",
      "Books & Stationery",
      "Clothing",
      "Accessories & Jewelry",
      "Other",
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

  it("disables staged categories and never commits them", () => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    const staged = screen.getByRole("button", { name: "Phones & Tablets" }) as HTMLButtonElement;
    expect(staged.disabled).toBe(true);
    fireEvent.click(staged);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("finds an unreleased category through a synonym but keeps it locked", () => {
    render(<CategoryField value="" onChange={() => {}} />);
    fireEvent.click(categoryTrigger());
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), {
      target: { value: "spectacles" },
    });
    const match = screen.getByRole("button", { name: "Watches & Eyewear" }) as HTMLButtonElement;
    expect(match.disabled).toBe(true);
  });

  it.each(["phone", "laptop", "camera"])("offers a released Electronics option when searching %s", (query) => {
    const onChange = vi.fn();
    render(<CategoryField value="" onChange={onChange} />);
    fireEvent.click(categoryTrigger());
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), { target: { value: query } });
    const option = screen.getByRole("button", { name: "Electronics" }) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("Electronics");
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

  it("marks the trigger invalid and announces the error", () => {
    render(<CategoryField value="" onChange={() => {}} error="Choose a category" />);
    expect(screen.getByRole("alert").textContent).toBe("Choose a category");
    expect(categoryTrigger().getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the selected value on the trigger", () => {
    render(<CategoryField value="Keys" onChange={() => {}} />);
    expect(categoryValue()).toBe("Keys");
  });
});
