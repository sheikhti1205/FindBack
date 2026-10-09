import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { SettingIconTile, type SettingIconTone } from "../../components/settings";

export interface SettingsNestedGroupProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  iconTone?: SettingIconTone;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Disclosure subgroup for the Settings root (Advanced, Help & about).
 * Native <details>/<summary>: keyboard-focusable, exposes expanded state to
 * assistive tech, needs no JS. Links live in the body — never nested inside
 * the summary control.
 */
export function SettingsNestedGroup({
  title,
  description,
  icon,
  iconTone,
  children,
  defaultOpen = false,
  className = "",
}: SettingsNestedGroupProps) {
  return (
    <details className={`fb-settings-nested ${className}`} open={defaultOpen || undefined}>
      <summary className="fb-settings-row fb-settings-nested-summary">
        {icon && <SettingIconTile icon={icon} tone={iconTone} />}
        <span className="fb-settings-row-copy">
          <span className="fb-settings-row-title">{title}</span>
          {description && (
            <span className="fb-settings-row-description">{description}</span>
          )}
        </span>
        <ChevronRight
          size={18}
          aria-hidden="true"
          className="fb-settings-chevron fb-settings-nested-chevron"
        />
      </summary>
      <div className="fb-settings-nested-body">{children}</div>
    </details>
  );
}
