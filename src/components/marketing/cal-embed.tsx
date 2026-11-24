"use client";

import { useEffect, useId, useState } from "react";

import { BOOK_CALL_CAL, BOOK_CALL_PAGE } from "@/lib/marketing/content";

type CalApi = ((...args: unknown[]) => void) & { loaded?: boolean; ns: Record<string, (...args: unknown[]) => void>; q: unknown[]; config?: Record<string, unknown> };

/**
 * Cal.com's own loader, as their embed snippet writes it: it queues calls until embed.js arrives, so
 * the calls below can be made at once. Kept to one script tag however often the page is opened.
 */
function loadCal(): CalApi {
  const w = window as unknown as { Cal?: CalApi };
  if (!w.Cal) {
    const push = (api: { q: unknown[] }, args: unknown) => api.q.push(args);
    const cal = function (...args: unknown[]) {
      const self = cal as unknown as CalApi;
      if (!self.loaded) {
        self.ns = {};
        self.q = self.q || [];
        document.head.appendChild(document.createElement("script")).src = `${BOOK_CALL_CAL.origin}/embed/embed.js`;
        self.loaded = true;
      }
      if (args[0] === "init") {
        const api = function (...inner: unknown[]) {
          push(api as unknown as { q: unknown[] }, inner);
        } as unknown as { q: unknown[] };
        const namespace = args[1];
        api.q = api.q || [];
        if (typeof namespace === "string") {
          self.ns[namespace] = self.ns[namespace] || (api as unknown as CalApi["ns"][string]);
          push(self.ns[namespace] as unknown as { q: unknown[] }, args);
          push(self, ["initNamespace", namespace]);
        } else push(self, args);
        return;
      }
      push(self, args);
    } as unknown as CalApi;
    cal.q = [];
    cal.ns = {};
    w.Cal = cal;
  }
  return w.Cal;
}

/**
 * The booking calendar, inline. Query parameters on the page (a campaign, a referrer) are passed on to
 * Cal.com. If the calendar can't load (an ad blocker, no network), a plain link to the booking page stays.
 */
export function CalEmbed() {
  const id = `cal-inline-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const { namespace, calLink, origin, brand } = BOOK_CALL_CAL;
    const Cal = loadCal();
    Cal("init", namespace, { origin });
    Cal.config = Cal.config || {};
    Cal.config.forwardQueryParams = true;
    const ns = Cal.ns[namespace];
    ns("inline", { elementOrSelector: `#${id}`, config: { layout: "month_view", useSlotsViewOnSmallScreen: "true", theme: "light" }, calLink });
    ns("ui", { theme: "light", cssVarsPerTheme: { light: { "cal-brand": brand } }, hideEventTypeDetails: false, layout: "month_view" });

    // The calendar is an iframe Cal.com adds to the box. Watch for it, and admit failure after a while.
    const box = document.getElementById(id);
    const seen = () => {
      if (box?.querySelector("iframe")) {
        setReady(true);
        return true;
      }
      return false;
    };
    const observer = new MutationObserver(() => {
      if (seen()) observer.disconnect();
    });
    if (box && !seen()) observer.observe(box, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
      if (!seen()) setFailed(true);
    }, 15000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [id]);

  const direct = `https://cal.com/${BOOK_CALL_CAL.calLink}`;
  return (
    <div className="relative">
      {!ready ? (
        <div role="status" className="absolute inset-x-0 top-0 grid place-items-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
          {failed ? (
            <span>
              {BOOK_CALL_PAGE.fallback}{" "}
              <a href={direct} target="_blank" rel="noopener noreferrer" className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
                {BOOK_CALL_PAGE.fallbackLink}
              </a>
              .
            </span>
          ) : (
            BOOK_CALL_PAGE.loading
          )}
        </div>
      ) : null}
      <div id={id} className="min-h-[32rem] w-full overflow-auto" />
    </div>
  );
}
