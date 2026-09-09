import type { Category } from "@findback/shared";
import { CATEGORIES } from "@findback/shared";
import { SelectField } from "./Fields";

export const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: c }));

interface CategoryFieldProps {
  value: Category | "";
  onChange: (value: Category | "") => void;
  error?: string;
}

export function CategoryField({ value, onChange, error }: CategoryFieldProps) {
  return (
    <SelectField
      label="Category"
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value as Category | "")}
      options={CATEGORY_OPTIONS}
    />
  );
}
