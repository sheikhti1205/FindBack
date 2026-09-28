// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdvancedSearchFilters,
  FiltersIconButton,
  getActiveFilterCount,
  useAdvancedSearchFilters,
} from "./AdvancedSearchFilters";

afterEach(cleanup);

describe("FiltersIconButton trigger variant", () => {
  it("badges the active count and carries it in the accessible name", () => {
    render(
      <MemoryRouter>
        <FiltersIconButton activeCount={2} open={false} onClick={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeTruthy();
    expect(screen.getByTestId("filters-active-count")).toHaveProperty("textContent", "2");
  });

  it("renders badge-free with a plain name when no filter is active", () => {
    render(
      <MemoryRouter>
        <FiltersIconButton activeCount={0} open={false} onClick={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(screen.queryByTestId("filters-active-count")).toBeNull();
  });
});

describe("AdvancedSearchFilters controlled + hideTrigger (Home search bar)", () => {
  function Inner() {
    const filters = useAdvancedSearchFilters();
    const [open, setOpen] = useState(false);
    return (
      <>
        <FiltersIconButton
          activeCount={getActiveFilterCount(filters)}
          open={open}
          onClick={() => setOpen(true)}
        />
        <AdvancedSearchFilters
          filters={filters}
          open={open}
          onOpenChange={setOpen}
          hideTrigger
        />
      </>
    );
  }

  function Harness({ entry = "/" }: { entry?: string }) {
    return (
      <MemoryRouter initialEntries={[entry]}>
        <Inner />
      </MemoryRouter>
    );
  }

  it("opens the same sheet from the embedded trigger without a block button", async () => {
    render(<Harness />);
    // Exactly one Filters launcher: the icon-button (no full-width block).
    expect(screen.getAllByRole("button", { name: "Filters" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("derives the badge and chips from the URL contract", async () => {
    render(<Harness entry="/?category=Electronics&status=OPEN" />);
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeTruthy();
    expect(screen.getByTestId("filters-active-count")).toHaveProperty("textContent", "2");
    expect(
      await screen.findByRole("button", { name: /remove category filter/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove status filter/i })).toBeTruthy();
  });
});
