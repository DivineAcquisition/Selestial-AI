"use client";

import { useLayoutEffect, useState } from "react";

import { overlayCollisionPadding } from "./tokens";

export type Placement = { side: "top" | "bottom"; maxHeight: number };

const PREFERRED = 288; // 18rem: the tallest a suggestion list grows.
const MINIMUM = 120; // Below this, the other side is used if it has more room.

/** The nearest ancestor that clips what overflows it (a dialog's body, a scrolling card), if any. */
function clippingAncestor(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Where an inline suggestion list should open: below its field when there is room, above it when there
 * is more room there, and never taller than the room it has. The room is what is left of the screen
 * after the sticky header and the edges, and of the nearest container that would clip it (a dialog, a
 * sheet, a scrolling card). For lists that cannot be portaled because they must stay inside a dialog's
 * interaction; portaled popups (Select, Combobox) are placed by their positioner instead.
 */
export function usePlacement(anchor: React.RefObject<HTMLElement | null>, open: boolean): Placement {
  const [placement, setPlacement] = useState<Placement>({ side: "bottom", maxHeight: PREFERRED });
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!open || !element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const pad = overlayCollisionPadding();
      let top = pad.top;
      let bottom = window.innerHeight - pad.bottom;
      const clip = clippingAncestor(element);
      if (clip) {
        const bounds = clip.getBoundingClientRect();
        top = Math.max(top, bounds.top + 4);
        bottom = Math.min(bottom, bounds.bottom - 4);
      }
      const below = bottom - box.bottom - 4;
      const above = box.top - top - 4;
      const side = below >= Math.min(PREFERRED, MINIMUM) || below >= above ? "bottom" : "top";
      const room = side === "bottom" ? below : above;
      setPlacement((current) => {
        const next = { side, maxHeight: Math.max(MINIMUM, Math.min(PREFERRED, Math.floor(room))) } as Placement;
        return current.side === next.side && current.maxHeight === next.maxHeight ? current : next;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor, open]);
  return placement;
}
