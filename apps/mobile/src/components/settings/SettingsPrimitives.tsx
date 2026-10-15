import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { Link, type To } from "react-router";
import { Check, ChevronRight, Search, X, type LucideIcon } from "lucide-react";
import { ACCENT_OPTIONS, type AccentId } from "../../appearance";
import type { Theme } from "../../theme";
import { density } from "../../design/density";
import { BackButton } from "../BackButton";
import "./settings.css";

const CATEGORY_TONES = {
  account: "blue", appearance: "lavender", accessibility: "teal", media: "amber",
  notifications: "coral", ai: "violet", privacy: "green", help: "sky", about: "neutral",
} as const;
export type SettingIconTone = keyof typeof CATEGORY_TONES | typeof CATEGORY_TONES[keyof typeof CATEGORY_TONES];

export interface SettingIconTileProps {
  icon: LucideIcon;
  tone?: SettingIconTone;
  className?: string;
}
/** Decorative category glyph; its row title carries the accessible meaning. */
export function SettingIconTile({ icon: Icon, tone = "neutral", className = "" }: SettingIconTileProps) {
  const color = tone in CATEGORY_TONES ? CATEGORY_TONES[tone as keyof typeof CATEGORY_TONES] : tone;
  return <span aria-hidden="true" data-tone={color} className={`fb-setting-icon ${className}`}><Icon size={density.iconSize} aria-hidden="true" /></span>;
}

export interface SettingsPageProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Uses the shared history-aware BackButton; omit for a root settings page. */
  backTo?: string;
  backLabel?: string;
  className?: string;
}
/** Content only: Shell remains the sole viewport/safe-area/scroll owner. */
export function SettingsPage({ title, description, children, backTo, backLabel = "Back to Settings", className = "" }: SettingsPageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus({ preventScroll: true });
    return () => {
      // Focus return: leaving the page restores the invoker so keyboard and
      // screen-reader users do not lose their place.
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [title]);
  return <section className={`fb-settings-page ${className}`}>
    <div className="fb-settings-sticky">
      {backTo && <BackButton fallbackTo={backTo} label={backLabel} />}
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
    </div>
    {description && <p className="fb-settings-page-description">{description}</p>}
    <div className="fb-settings-page-content">{children}</div>
  </section>;
}

export interface SettingsGroupProps {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}
export function SettingsGroup({ title, description, children, className = "" }: SettingsGroupProps) {
  const id = useId();
  return <section aria-labelledby={title ? `${id}-title` : undefined} aria-describedby={description ? `${id}-description` : undefined} className={`fb-settings-group ${className}`}>
    {(title || description) && <header className="fb-settings-group-header">
      {title && <h2 id={`${id}-title`}>{title}</h2>}
      {description && <p id={`${id}-description`}>{description}</p>}
    </header>}
    <div className="fb-settings-group-card">{children}</div>
  </section>;
}

export interface SettingsRowContentProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  iconTone?: SettingIconTone;
  /** Display-only content; never put an interactive control inside a row. */
  value?: ReactNode;
  badge?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
}
export type SettingsRowProps = SettingsRowContentProps & (
  | { route: To; onClick?: never }
  | { route?: never; onClick?: () => void }
);

export function SettingsRow({ title, description, icon, iconTone, value, badge, route, onClick, destructive = false, disabled = false, className = "" }: SettingsRowProps) {
  const id = useId();
  const describedBy = [description && `${id}-description`, value != null && `${id}-value`, badge != null && `${id}-badge`].filter(Boolean).join(" ") || undefined;
  const content = <>
    {icon && <SettingIconTile icon={icon} tone={iconTone} />}
    <span className="fb-settings-row-copy">
      <span id={`${id}-title`} className="fb-settings-row-title">{title}</span>
      {description && <span id={`${id}-description`} className="fb-settings-row-description">{description}</span>}
    </span>
    {badge != null && <span id={`${id}-badge`} className="fb-settings-row-badge">{badge}</span>}
    {value != null && <span id={`${id}-value`} className="fb-settings-row-value">{value}</span>}
    {route && <ChevronRight size={18} aria-hidden="true" className="fb-settings-chevron" />}
  </>;
  const common = {
    className: `fb-settings-row ${className}`,
    "data-destructive": destructive || undefined,
    "aria-labelledby": `${id}-title`,
    "aria-describedby": describedBy,
  };
  if (route && !disabled) return <Link {...common} to={route}>{content}</Link>;
  if (onClick) return <button {...common} type="button" onClick={onClick} disabled={disabled}>{content}</button>;
  return <div {...common} aria-disabled={disabled || undefined}>{content}</div>;
}

export interface PreferenceSwitchRowProps extends Omit<SettingsRowContentProps, "value" | "badge" | "destructive"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}
/** One native button target. Space/Enter toggle; assistive tech announces state. */
export function PreferenceSwitchRow({ title, description, icon, iconTone, checked, onChange, disabled = false, className = "" }: PreferenceSwitchRowProps) {
  const id = useId();
  return <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} disabled={disabled} onClick={() => onChange(!checked)} className={`fb-settings-row ${className}`}>
    {icon && <SettingIconTile icon={icon} tone={iconTone} />}
    <span className="fb-settings-row-copy">
      <span id={`${id}-title`} className="fb-settings-row-title">{title}</span>
      {description && <span id={`${id}-description`} className="fb-settings-row-description">{description}</span>}
    </span>
    <span aria-hidden="true" className="fb-switch-track" data-checked={checked}>
      <span className="fb-switch-thumb">{checked && <Check size={14} strokeWidth={3} />}</span>
    </span>
  </button>;
}

export interface SettingsSearchResult extends Omit<SettingsRowContentProps, "value" | "badge" | "destructive" | "disabled" | "className"> {
  id: string;
  route: To;
}
export interface SettingsSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Caller owns filtering; results are ordinary links, not a combobox. */
  results?: readonly SettingsSearchResult[];
  label?: string;
  placeholder?: string;
  className?: string;
}
export function SettingsSearch({ query, onQueryChange, results, label = "Search settings", placeholder = "Search settings", className = "" }: SettingsSearchProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0 && results !== undefined;
  return <div className={`fb-settings-search ${className}`}>
    <label htmlFor={id} className="sr-only">{label}</label>
    <div className="fb-settings-search-field">
      <Search size={20} aria-hidden="true" />
      <input ref={input} id={id} type="search" value={query} placeholder={placeholder} onChange={(event) => onQueryChange(event.target.value)} />
      {query && <button type="button" aria-label="Clear search" onClick={() => { onQueryChange(""); input.current?.focus(); }}><X size={18} aria-hidden="true" /></button>}
    </div>
    {searching && <>
      <p role="status" className="fb-settings-search-status">{results.length ? `${results.length} ${results.length === 1 ? "setting" : "settings"} found` : "No settings found. Try a different word."}</p>
      {results.length > 0 && <ul className="fb-settings-results" aria-label="Settings search results">
        {results.map(({ id: key, ...row }) => <li key={key}><SettingsRow {...row} /></li>)}
      </ul>}
    </>}
  </div>;
}

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const THEME_HINTS: Record<Theme, string> = { system: "Follows your device", light: "Bright and soft", dark: "Comfortably dim" };
export interface ThemeCardProps {
  name: string;
  value: Theme;
  checked: boolean;
  onChange: (theme: Theme) => void;
  disabled?: boolean;
  description?: string;
}
/** Use inside a fieldset+legend; shared name supplies native arrow-key behavior. */
export function ThemeCard({ name, value, checked, onChange, disabled = false, description = THEME_HINTS[value] }: ThemeCardProps) {
  const id = useId();
  return <label className="fb-choice fb-theme-card" data-checked={checked} data-disabled={disabled}>
    <input className="fb-choice-input" type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} />
    <span className="fb-theme-preview" data-theme={value} aria-hidden="true"><span /><span /></span>
    <span className="fb-choice-title" id={`${id}-label`}>{THEME_LABELS[value]}{checked && <Check size={16} aria-hidden="true" />}</span>
    <span className="fb-choice-description" id={`${id}-description`}>{description}</span>
  </label>;
}

export interface PreferenceRadioRowProps {
  name: string;
  value: string;
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  className?: string;
}
/**
 * One native radio in a choice list.
 *
 * Use inside `fieldset.fb-choice-fieldset` + `div.fb-choice-list`; every row in
 * one group shares `name`, so the browser's own arrow-key behaviour moves
 * between options and the list draws its hairline separators. `aria-checked`,
 * focus ring and 48px target come from the settings foundation.
 */
export function PreferenceRadioRow({ name, value, title, description, checked, onChange, disabled = false, className = "" }: PreferenceRadioRowProps) {
  const id = useId();
  return <label className={`fb-choice ${className}`} data-checked={checked} data-disabled={disabled}>
    <input className="fb-choice-input" type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange()} aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-description` : undefined} />
    <span className="fb-choice-title" id={`${id}-label`}>{title}{checked && <Check size={16} aria-hidden="true" />}</span>
    {description && <span className="fb-choice-description" id={`${id}-description`}>{description}</span>}
  </label>;
}

export interface AccentSwatchProps {
  name: string;
  accent: AccentId;
  checked: boolean;
  onChange: (accent: AccentId) => void;
  disabled?: boolean;
}
export function AccentSwatch({ name, accent, checked, onChange, disabled = false }: AccentSwatchProps) {
  const option = ACCENT_OPTIONS.find((a) => a.id === accent) ?? ACCENT_OPTIONS[0]!;
  const id = useId();
  const style = {
    "--fb-swatch-light": option.swatch, "--fb-swatch-dark": option.darkSwatch,
    "--fb-swatch-on-light": option.onAccent, "--fb-swatch-on-dark": option.darkOnAccent,
  } as CSSProperties;
  return <label className="fb-choice fb-accent-swatch" style={style} data-checked={checked} data-disabled={disabled}>
    <input className="fb-choice-input" type="radio" name={name} value={option.id} checked={checked} disabled={disabled} onChange={() => onChange(option.id)} aria-labelledby={id} />
    <span className="fb-accent-dot" aria-hidden="true">{checked && <Check size={20} strokeWidth={3} />}</span>
    <span id={id} className="fb-choice-title">{option.label}</span>
  </label>;
}

export interface StatusPillProps {
  tone?: "success" | "warning" | "error" | "neutral" | "accent";
  children: ReactNode;
}
/** Display status only; caller owns live announcements for async changes. */
export function StatusPill({ tone = "neutral", children }: StatusPillProps) {
  return <span className="fb-status-pill" data-tone={tone}>{children}</span>;
}

export interface AdvancedDisclosureProps {
  title?: string;
  children: ReactNode;
}
export function AdvancedDisclosure({ title = "Technical details", children }: AdvancedDisclosureProps) {
  return <details className="fb-advanced-disclosure"><summary>{title}</summary><div>{children}</div></details>;
}
