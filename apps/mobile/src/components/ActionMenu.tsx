import { useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { Button, Menu, MenuItem, MenuTrigger, Separator, SubmenuTrigger } from "react-aria-components";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { LayeredPopover } from "./overlayFoundation";
import { useFinePointer } from "./inputCapabilities";
import { COMPACT_MAX_PX, useViewportWidth } from "./responsive";

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onAction: () => void;
}
export interface MenuGroup {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Deliberately one level; no recursive flyout labyrinth. */
  items: readonly MenuAction[];
}

function actionRows(items: readonly MenuAction[]) {
  return items.flatMap((item, index) => [
    ...(item.destructive && !items[index - 1]?.destructive && index > 0 ? [<Separator key={`separator-${item.id}`} className="fb-menu-separator" />] : []),
    <MenuItem key={item.id} id={item.id} textValue={item.label} isDisabled={item.disabled}
      onAction={item.onAction} className={`fb-menu-item ${item.destructive ? "fb-menu-danger" : ""}`}>
      {item.icon}<span>{item.label}</span>
    </MenuItem>,
  ]);
}

/** Anchored actions on every input/width. Never turns a simple action into a sheet. */
export function ActionMenu({ label, items, icon, disabled = false, open: controlledOpen, onOpenChange, triggerClassName = "fb-icon-control", feedback }: {
  label: string;
  items: readonly (MenuAction | MenuGroup)[];
  icon?: ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  /** Keep operation feedback in the active layer, not in its inert background. */
  feedback?: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const leaveOnTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    // RAC's modal Popover contains Tab. A menu must instead dismiss and let
    // the browser advance from its launcher (the parent dialog still traps).
    // Remove containment/inert synchronously before the native default action.
    flushSync(() => setOpen(false));
    trigger.current?.focus({ preventScroll: true });
  };
  const finePointer = useFinePointer();
  const width = useViewportWidth();
  // Sideways collision flipping cannot fit two 15rem panels into a narrow
  // window. Touch uses a stacked second panel; roomy fine-pointer gets flyout.
  const flyout = finePointer && width >= COMPACT_MAX_PX;
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}>
    <Button ref={trigger} aria-label={label} isDisabled={disabled} className={triggerClassName}>
      {icon ?? <MoreHorizontal size={20} aria-hidden="true" />}
    </Button>
    <LayeredPopover placement="bottom end" offset={4}>
      <div onKeyDownCapture={leaveOnTab}>
      {feedback}
      <Menu aria-label={label} className="fb-action-menu">
        {items.flatMap((item, index) => {
          if (!("items" in item)) return [
            ...(item.destructive && !(items[index - 1] as MenuAction | undefined)?.destructive && index > 0 ? [<Separator key={`separator-${item.id}`} className="fb-menu-separator" />] : []),
            ...actionRows([item]),
          ];
          return [<SubmenuTrigger key={item.id}>
            <MenuItem id={item.id} textValue={item.label} isDisabled={item.disabled} className="fb-menu-item">
              {item.icon}<span>{item.label}</span><ChevronRight size={16} aria-hidden="true" />
            </MenuItem>
            <LayeredPopover placement={flyout ? "end top" : "bottom start"} offset={4}>
              <Menu aria-label={item.label} className="fb-action-menu">{actionRows(item.items)}</Menu>
            </LayeredPopover>
          </SubmenuTrigger>];
        })}
      </Menu>
      </div>
    </LayeredPopover>
  </MenuTrigger>;
}
