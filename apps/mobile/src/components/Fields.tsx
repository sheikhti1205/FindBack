import { useId, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-on-surface">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-on-surface-variant">{hint}</span>
      ) : null}
    </label>
  );
}

const baseField =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none disabled:opacity-50";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function TextField({ label, error, hint, className = "", ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} hint={hint}>
      <input
        id={id}
        className={`${baseField} ${error ? "border-error" : ""} ${className}`}
        {...rest}
      />
    </FieldShell>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}

export function SelectField({
  label,
  error,
  options,
  placeholder = "Select…",
  className = "",
  ...rest
}: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} error={error}>
      <select
        id={id}
        className={`${baseField} appearance-none ${error ? "border-error" : ""} ${className}`}
        {...rest}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className="mt-1 block text-xs text-error" role="alert">
      {message}
    </span>
  );
}
