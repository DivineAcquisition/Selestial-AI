"use client";

import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";

/**
 * A form in a dialog. The content is mounted only while open, so each opening starts clean. `returnFocus`
 * is where the keyboard goes when it closes, for a dialog opened from something that is gone by then,
 * such as a menu item.
 */
export function Modal({ open, onClose, title, description, returnFocus, children }: { open: boolean; onClose: () => void; title: string; description?: string; returnFocus?: React.RefObject<HTMLElement | null>; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="bg-card" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>{open ? children : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
