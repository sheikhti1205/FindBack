import { useId } from "react";

/**
 * Accessible OTP input: ONE real input (screen-reader/keyboard/paste friendly)
 * with grouped visual cells rendered aria-hidden beneath it. The cells are
 * pure decoration — all interaction goes through the single labelled input.
 */
export function OtpField({
  label = "Verification code",
  value,
  onChange,
  maxLength = 6,
  disabled = false,
}: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  maxLength?: 6 | 10;
  disabled?: boolean;
}) {
  const id = useId();
  const digits = value.replace(/\D/g, "").slice(0, maxLength);

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-on-surface">
        {label}
      </label>
      <div
        aria-hidden="true"
        className="mb-2 grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${maxLength}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: maxLength }, (_, i) => (
          <span
            key={i}
            className={`flex min-h-[44px] items-center justify-center rounded-m3-sm border text-lg font-semibold ${
              digits[i] != null
                ? "border-on-surface text-on-surface"
                : i === digits.length
                  ? "border-on-surface text-on-surface-variant"
                  : "border-outline-variant text-on-surface-variant"
            }`}
          >
            {digits[i] ?? ""}
          </span>
        ))}
      </div>
      <input
        id={id}
        value={digits}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, maxLength))}
        onPaste={(event) => {
          event.preventDefault();
          onChange(event.clipboardData.getData("text").replace(/\D/g, "").slice(0, maxLength));
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="Enter code"
        maxLength={maxLength}
        disabled={disabled}
        className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base tracking-[0.3em] text-on-surface placeholder:tracking-normal placeholder:text-on-surface-variant focus:border-on-surface"
      />
    </div>
  );
}
