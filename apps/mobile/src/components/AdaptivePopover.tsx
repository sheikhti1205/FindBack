import { useState, type ReactNode } from "react";
import { Button, Dialog, DialogTrigger, Heading } from "react-aria-components";
import { LayeredPopover } from "./overlayFoundation";

/** Non-menu interactive quick view (identity, notifications), never a tooltip. */
export function AdaptivePopover({ label, trigger, children }: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <DialogTrigger isOpen={open} onOpenChange={setOpen}>
    <Button aria-label={label} className="fb-quick-trigger">{trigger}</Button>
    <LayeredPopover placement="bottom start" offset={6} className="fb-quick-popover">
      <Dialog className="fb-quick-dialog">
        <Heading slot="title" className="sr-only">{label}</Heading>
        {children}
      </Dialog>
    </LayeredPopover>
  </DialogTrigger>;
}
