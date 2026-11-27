"use client";

/**
 * The in-product notice about a changed legal document (convex/trust.ts documentNotices): the Privacy notice
 * promises account holders are told about material changes in the product. A quiet bar under the header with
 * what changed, a link to the full text, and a way to close it. Closing is remembered for the person, so it
 * isn't shown again in this or any other company they belong to.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { FileText } from "@/components/icons";
import { Button } from "@/components/ui/button";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

const PATHS: Record<string, string> = { terms: "/terms", privacy: "/privacy", cookies: "/cookies", messaging: "/messaging", security: "/security", eula: "/eula" };
const date = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function DocumentNotice({ companyId }: { companyId: Id<"companies"> }) {
  const notices = useQuery(api.trust.documentNotices, { companyId });
  const dismiss = useMutation(api.trust.dismissDocumentNotice);
  // Hidden at once when closed, without waiting for the server to answer.
  const [closed, setClosed] = useState<string[]>([]);
  const notice = notices?.find((row) => !closed.includes(row.documentId));
  if (!notice) return null;
  return (
    <div role="status" aria-label={`${notice.title} updated`} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-brand-500/20 bg-brand-500/[0.06] px-4 py-2.5 text-sm text-strong sm:items-center sm:px-6">
      <FileText className="mt-0.5 size-4 shrink-0 text-brand-600 sm:mt-0" aria-hidden />
      <p className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">
        <span className="font-medium">
          We updated our {notice.title}, effective {date(notice.effectiveOn)}.
        </span>{" "}
        <span className="text-muted-foreground">{notice.notice}</span>
      </p>
      <span className="ml-8 flex shrink-0 items-center gap-2 sm:ml-0">
        <Link href={PATHS[notice.kind] ?? "/privacy"} target="_blank" className="text-sm font-medium text-brand-600 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-500">
          Read the {notice.title}
        </Link>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setClosed((ids) => [...ids, notice.documentId]);
            void dismiss({ companyId, documentId: notice.documentId }).catch(() => undefined);
          }}
        >
          Got it
        </Button>
      </span>
    </div>
  );
}
