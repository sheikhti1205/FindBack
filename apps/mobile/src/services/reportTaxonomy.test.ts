import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_CATALOG,
  CATEGORY_GROUPS,
  PROPOSED_CATEGORIES,
  RELEASED_CATEGORIES,
  isReleasedCategory,
  searchCategoryCatalog,
} from "@findback/shared";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20260926000001_category_expansion.sql");

const ORIGINAL_EIGHT = [
  "Electronics",
  "Bags & Wallets",
  "Keys",
  "Documents & IDs",
  "Books & Stationery",
  "Clothing",
  "Accessories & Jewelry",
  "Other",
];

describe("category taxonomy (P3)", () => {
  it("releases all 25 canonical strings with the original eight first", () => {
    expect([...RELEASED_CATEGORIES]).toEqual([
      ...ORIGINAL_EIGHT,
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

  it("holds 25 total canonical options with nothing left staged", () => {
    expect(CATEGORY_CATALOG).toHaveLength(25);
    expect(new Set(CATEGORY_CATALOG.map((o) => o.canonical)).size).toBe(25);
    expect(PROPOSED_CATEGORIES).toHaveLength(0);
    expect([...RELEASED_CATEGORIES].sort()).toEqual(
      CATEGORY_CATALOG.map((o) => o.canonical).sort(),
    );
  });

  it("places every option in a declared group and keeps Other in the fallback group", () => {
    for (const option of CATEGORY_CATALOG) {
      expect(CATEGORY_GROUPS).toContain(option.group);
    }
    expect(CATEGORY_CATALOG.find((o) => o.canonical === "Other")?.group).toBe("Other");
  });

  it("treats every catalog option as released and still rejects unknown strings", () => {
    expect(isReleasedCategory("Electronics")).toBe(true);
    expect(isReleasedCategory("Phones & Tablets")).toBe(true);
    expect(isReleasedCategory("Pet Accessories")).toBe(true);
    expect(isReleasedCategory("not-a-category")).toBe(false);
  });

  it("matches synonyms and ignores case/diacritics in search", () => {
    expect(searchCategoryCatalog("power bank").map((o) => o.canonical)).toContain("Electronics");
    expect(searchCategoryCatalog("SPECTACLES").map((o) => o.canonical)).toContain("Watches & Eyewear");
    expect(searchCategoryCatalog("jewellery").map((o) => o.canonical)).toContain("Accessories & Jewelry");
    expect(searchCategoryCatalog("")).toHaveLength(25);
    expect(searchCategoryCatalog("zzzz")).toHaveLength(0);
  });

  it("keeps the staged SQL migration whitelist exactly equal to the catalog", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const whitelistBlock = sql.match(/p_category not in \(([\s\S]*?)\) then/);
    const listBody = whitelistBlock?.[1];
    expect(listBody, "category whitelist block present in migration").toBeTruthy();
    const sqlValues = [...(listBody ?? "").matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
      (m[1] ?? "").replace(/''/g, "'"),
    );
    const catalogValues = CATEGORY_CATALOG.map((o) => o.canonical);
    expect(sqlValues).toHaveLength(25);
    expect([...sqlValues].sort()).toEqual([...catalogValues].sort());
    for (const original of ORIGINAL_EIGHT) {
      expect(sqlValues).toContain(original);
    }
  });
});
