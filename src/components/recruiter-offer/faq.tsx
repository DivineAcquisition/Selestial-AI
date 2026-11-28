"use client";

import { trackRecruiter } from "@/lib/recruiter-offer/analytics";

/**
 * Native disclosure widgets: each question is a <summary>, reachable with Tab and opened with Enter or
 * Space, announced as expanded or collapsed. Opening one records which, by position only.
 */
export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  return (
    <div className="divide-y divide-border border-y border-border">
      {items.map((item, i) => (
        <details
          key={item.q}
          className="group py-1"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) trackRecruiter("recruiter_faq_opened", { item: String(i + 1) });
          }}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left font-heading text-[17px] tracking-tight text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6838ef] [&::-webkit-details-marker]:hidden">
            {item.q}
            <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </summary>
          <p className="max-w-2xl pb-5 text-[15px] leading-relaxed text-muted-foreground">{item.a}</p>
        </details>
      ))}
    </div>
  );
}
