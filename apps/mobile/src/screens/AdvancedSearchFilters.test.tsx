// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("updates the badge count when a chip is removed", async () => {
    render(<Harness entry="/?category=Electronics&status=OPEN" />);
    expect(await screen.findByRole("button", { name: /remove category filter/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /remove category filter/i }));

    expect(await screen.findByRole("button", { name: "Filters, 1 active" })).toBeTruthy();
    expect(screen.getByTestId("filters-active-count")).toHaveProperty("textContent", "1");
    // The removed chip plays its 150ms exit fade before leaving the DOM.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /remove category filter/i })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /remove status filter/i })).toBeTruthy();
  });
});

describe("AdvancedSearchFilters optional date range", () => {
  function SheetHarness({
    appliedFrom = "",
    appliedTo = "",
    draftFrom,
    draftTo,
  }: {
    appliedFrom?: string;
    appliedTo?: string;
    draftFrom?: string;
    draftTo?: string;
  }) {
    const filters = useAdvancedSearchFilters();
    const [open, setOpen] = useState(false);
    const [range, setRange] = useState({ from: appliedFrom, to: appliedTo });
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
          dateRange={{
            from: range.from,
            to: range.to,
            draftFrom,
            draftTo,
            onFromChange: (value: string) => setRange(current => ({ ...current, from: value })),
            onToChange: (value: string) => setRange(current => ({ ...current, to: value })),
          }}
        />
      </>
    );
  }

  /** Home shares this sheet and has no date controls at all. */
  function HomeLike() {
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

  it("offers the two date fields when the caller passes a range", async () => {
    render(
      <MemoryRouter>
        <SheetHarness appliedFrom="2026-10-01" appliedTo="2026-10-21" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect((await screen.findByLabelText("From date") as HTMLInputElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("2026-10-21");
  });

  it("keeps the caller's values when a date is edited", async () => {
    render(
      <MemoryRouter>
        <SheetHarness appliedFrom="2026-10-01" appliedTo="2026-10-21" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(await screen.findByLabelText("From date"), { target: { value: "2026-09-18" } });

    await waitFor(() =>
      expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe("2026-09-18"),
    );
  });

  it("shows the draft in the fields while the chips count the applied bounds", async () => {
    // A range the reader entered but that is not applied (a reversed range)
    // stays visible so it can be fixed — and it must not be counted as a
    // filter the reader has on.
    render(
      <MemoryRouter>
        <SheetHarness appliedFrom="" appliedTo="" draftFrom="2026-10-21" draftTo="2026-01-01" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect((await screen.findByLabelText("From date") as HTMLInputElement).value).toBe("2026-10-21");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("2026-01-01");
    expect(screen.queryByRole("button", { name: /remove start date filter/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove end date filter/i })).toBeNull();
  });

  it("offers no date fields when the caller passes none (Home's default)", async () => {
    // Home shares this sheet and has no date controls: the optional prop must
    // not add fields there.
    render(
      <MemoryRouter>
        <HomeLike />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(screen.queryByLabelText("From date")).toBeNull();
    expect(screen.queryByLabelText("To date")).toBeNull();
  });

  it("keeps Home's sheet shape: a medium sheet that says what it holds", async () => {
    // Home's sheet is shared, so its shape is pinned here: the optional date
    // range must not change Home's height or its description.
    render(
      <MemoryRouter>
        <HomeLike />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    const dialog = await screen.findByRole("dialog", { name: "Filters" });
    expect(dialog.getAttribute("data-height")).toBe("medium");
    expect(
      screen.getByText("Category, status and sort. Changes apply immediately."),
    ).toBeTruthy();
  });

  it("gives the sheet the large height and its own description when dates are offered", async () => {
    render(
      <MemoryRouter>
        <SheetHarness appliedFrom="2026-10-01" appliedTo="2026-10-21" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    const dialog = await screen.findByRole("dialog", { name: "Filters" });
    expect(dialog.getAttribute("data-height")).toBe("large");
    expect(screen.getByText("Changes apply immediately.")).toBeTruthy();
  });
});

describe("AdvancedSearchFilters optional type and place (Search only)", () => {
  function SheetHarness({
    type = "",
    placeValue = "",
    placeApplied = "",
    onTypeChange = () => {},
    onPlaceChange = () => {},
  }: {
    type?: "LOST" | "FOUND" | "";
    placeValue?: string;
    placeApplied?: string;
    onTypeChange?: (value: "LOST" | "FOUND" | "") => void;
    onPlaceChange?: (value: string) => void;
  }) {
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
          postType={{ value: type, onChange: onTypeChange }}
          place={{ value: placeValue, applied: placeApplied, onChange: onPlaceChange }}
        />
      </>
    );
  }

  it("summarises the type as a chip and offers the way out", () => {
    const onTypeChange = vi.fn();
    render(
      <MemoryRouter>
        <SheetHarness type="LOST" onTypeChange={onTypeChange} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Type: Lost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove type filter" }));
    expect(onTypeChange).toHaveBeenCalledWith("");
  });

  it("counts the type in the Filters badge", () => {
    // A reader with only a type filter must not see a chip on screen and no
    // count beside it: the badge counts every filter the reader has on.
    function TypeOnlyHarness() {
      const filters = useAdvancedSearchFilters();
      return (
        <AdvancedSearchFilters
          filters={filters}
          postType={{ value: "LOST", onChange: () => {} }}
        />
      );
    }
    render(
      <MemoryRouter>
        <TypeOnlyHarness />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
    // The way out is offered too: the type IS a filter now.
    expect(screen.getByRole("button", { name: "Clear all filters" })).toBeTruthy();
  });

  it("shows no type chip when no type is chosen", () => {
    render(
      <MemoryRouter>
        <SheetHarness type="" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/^Type:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove type filter" })).toBeNull();
  });

  it("summarises the place as a chip and offers the way out", () => {
    const onPlaceChange = vi.fn();
    render(
      <MemoryRouter>
        <SheetHarness placeValue="Gulshan" placeApplied="Gulshan" onPlaceChange={onPlaceChange} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Place: Gulshan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove place filter" }));
    expect(onPlaceChange).toHaveBeenCalledWith("");
  });

  it("offers the Place field with the reader's own text", async () => {
    render(
      <MemoryRouter>
        <SheetHarness placeValue="Gulshan" placeApplied="Gulshan" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    const field = (await screen.findByLabelText("Place")) as HTMLInputElement;
    expect(field.value).toBe("Gulshan");
  });

  it("explains a value that is not a place name instead of hiding it", async () => {
    // A coordinate is never a place: the reader is told why it is not a
    // filter, rather than watching a filter that never applies — and the
    // sentence names the RIGHT reason.
    render(
      <MemoryRouter>
        <SheetHarness placeValue="23.8103, 90.4125" placeApplied="" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect((await screen.findByLabelText("Place"))).toBeTruthy();
    expect(screen.getByText(/a map coordinate is not a place/i)).toBeTruthy();
    // No chip claims a place that is not in force.
    expect(screen.queryByText(/^Place:/)).toBeNull();
  });

  it("names the reason a place was refused, one reason per mistake", async () => {
    // A bare number, a coordinate and an over-long name are three different
    // mistakes: one sentence cannot be true of all of them.
    const { unmount } = render(
      <MemoryRouter>
        <SheetHarness placeValue="221" placeApplied="" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByText(/type the name of a place, not a number/i)).toBeTruthy();
    unmount();

    render(
      <MemoryRouter>
        <SheetHarness placeValue={"x".repeat(120)} placeApplied="" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByText(/too long/i)).toBeTruthy();
  });

  it("keeps Home's sheet free of the type and the place", async () => {
    // Home shares this sheet and has neither: the optional props must not
    // add fields or chips there.
    function HomeLike() {
      const filters = useAdvancedSearchFilters();
      const [open, setOpen] = useState(false);
      return (
        <>
          <FiltersIconButton
            activeCount={getActiveFilterCount(filters)}
            open={open}
            onClick={() => setOpen(true)}
          />
          <AdvancedSearchFilters filters={filters} open={open} onOpenChange={setOpen} hideTrigger />
        </>
      );
    }
    render(
      <MemoryRouter>
        <HomeLike />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));

    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(screen.queryByLabelText("Place")).toBeNull();
    expect(screen.queryByText(/^Type:/)).toBeNull();
  });
});
