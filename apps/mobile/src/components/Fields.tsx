import { useId, useState, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, EyeOff } from "lucide-react";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
} from "./uiMotion";

interface FieldShellProps {
  label: string;
  /** id of the control this label describes (explicit association). */
  htmlFor: string;
  hint?: string;
  error?: string;
  errorId?: string;
  hintId?: string;
  /** Live availability/status line (role="status"), e.g. username checking. */
  status?: ReactNode;
  statusId?: string;
  /** True while the control has focus — drives the label lift. */
  focused?: boolean;
  /** Trailing control overlaid on the control (password reveal). */
  trailing?: ReactNode;
  children: ReactNode;
}

/**
 * Hint/validation message that grows from closed to its natural height and
 * collapses again. Height is the one sanctioned layout animation here: single
 * line and wrapped message both settle at the message's real height, and
 * there is deliberately no shake.
 */
export function AnimatedNote({
  id,
  role,
  className,
  children,
}: {
  id?: string;
  role?: "alert";
  className: string;
  children: ReactNode;
}) {
  return (
    <motion.span
      id={id}
      role={role}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
      className={`block overflow-hidden ${className}`}
    >
      {children}
    </motion.span>
  );
}

function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  errorId,
  hintId,
  status,
  statusId,
  focused,
  trailing,
  children,
}: FieldShellProps) {
  return (
    <div className="block">
      {/* Subtle focus acknowledgement: the label lifts a pixel, the border
          colour transition is handled by baseField's focus: rules. */}
      <motion.label
        htmlFor={htmlFor}
        animate={{ y: focused ? -1 : 0 }}
        transition={{ duration: motionDurations.instant, ease: motionEasings.out }}
        className="mb-1 block text-sm font-medium text-on-surface"
      >
        {label}
      </motion.label>
      <div className="relative">
        {children}
        {trailing}
      </div>
      {/* Hint and error share one slot so one leaves as the other arrives. */}
      <AnimatePresence initial={false}>
        {error ? (
          <AnimatedNote key="error" id={errorId} role="alert" className="mt-1 text-xs text-error">
            {error}
          </AnimatedNote>
        ) : hint ? (
          <AnimatedNote key="hint" id={hintId} className="mt-1 text-xs text-on-surface-variant">
            {hint}
          </AnimatedNote>
        ) : null}
      </AnimatePresence>
      {/* One live region that persists across text updates — no blink. */}
      <AnimatePresence initial={false}>
        {status != null ? (
          <motion.span
            key="status"
            id={statusId}
            role="status"
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="mt-1 block text-xs text-on-surface"
          >
            {status}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const baseField =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-on-surface disabled:opacity-50 transition-colors";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  /** Live availability/status line rendered under the field. */
  status?: ReactNode;
}

export function TextField({
  label,
  error,
  hint,
  status,
  className = "",
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const statusId = `${id}-status`;
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const isPassword = rest.type === "password";
  const inputType = isPassword ? (revealed ? "text" : "password") : rest.type;

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      status={status}
      errorId={errorId}
      hintId={hintId}
      statusId={statusId}
      focused={focused}
      trailing={
        isPassword ? (
          <motion.button
            type="button"
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
            whileTap={pressFeedback.iconButton}
            animate={{ opacity: focused ? 1 : 0.7 }}
            transition={motionSprings.snappy}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-m3-sm text-on-surface-variant"
          >
            {/* Two stacked glyphs: the icon crossfades and rotates on toggle. */}
            <span className="relative block h-5 w-5">
              <motion.span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center"
                initial={false}
                animate={{ opacity: revealed ? 0 : 1, rotate: revealed ? -90 : 0 }}
                transition={motionSprings.snappy}
              >
                <Eye size={20} />
              </motion.span>
              <motion.span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center"
                initial={false}
                animate={{ opacity: revealed ? 1 : 0, rotate: revealed ? 0 : 90 }}
                transition={motionSprings.snappy}
              >
                <EyeOff size={20} />
              </motion.span>
            </span>
          </motion.button>
        ) : undefined
      }
    >
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={`${baseField} ${isPassword ? "pr-12" : ""} ${error ? "border-error" : ""} ${className}`}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        {...rest}
        type={inputType}
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
  onFocus,
  onBlur,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell label={label} htmlFor={id} error={error} errorId={errorId} focused={focused}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${baseField} appearance-none ${error ? "border-error" : ""} ${className}`}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
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
