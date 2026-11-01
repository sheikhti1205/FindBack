import { useState, type ReactNode } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { LayeredPopover } from "./overlayFoundation";
import { Notifications } from "../screens/Notifications";

/** A quick inbox presentation, not a second data cache or mutation owner. */
export function NotificationPopover({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <DialogTrigger isOpen={open} onOpenChange={setOpen}>
    <Button aria-label="Notifications" className="fb-icon-control relative">{trigger}</Button>
    <LayeredPopover placement="bottom end" offset={6} maxHeight={680} className="fb-notification-popover">
      <Dialog className="fb-notification-dialog">
        <Notifications preview onNavigate={() => setOpen(false)} />
      </Dialog>
    </LayeredPopover>
  </DialogTrigger>;
}
