import { useState, type ReactNode } from "react";
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
export function ActionMenu({ label, items, icon, disabled = false }: {
  label: string;
  items: readonly (MenuAction | MenuGroup)[];
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const finePointer = useFinePointer();
  const width = useViewportWidth();
  // Sideways collision flipping cannot fit two 15rem panels into a narrow
  // window. Touch uses a stacked second panel; roomy fine-pointer gets flyout.
  const flyout = finePointer && width >= COMPACT_MAX_PX;
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}>
    <Button aria-label={label} isDisabled={disabled} className="fb-icon-control">
      {icon ?? <MoreHorizontal size={20} aria-hidden="true" />}
    </Button>
    <LayeredPopover placement="bottom end" offset={4}>
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
    </LayeredPopover>
  </MenuTrigger>;
}
