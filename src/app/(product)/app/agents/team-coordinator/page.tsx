import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/app/shell";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button-variants";

export const metadata: Metadata = { title: "Team Coordinator was retired" };

/**
 * Team Coordinator was retired on November 22, 2026, before it was ever released. Its work has owners that
 * already run: Recruiter prepares a new cleaner, the Cleaners workspace holds the record, and Dispatch
 * coordinates eligible work. Old links land here and are pointed onward.
 */
export default function Page() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <PageHeader title="Team Coordinator's work moved" lead="Team Coordinator is no longer a separate agent. Nothing was lost: each part of its work has an owner that already runs." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="gap-2 p-4">
          <p className="text-sm font-semibold text-strong">Recruiter</p>
          <p className="text-sm text-muted-foreground">Gets a new cleaner ready: onboarding items, documents, agreement, and the readiness approval.</p>
          <Link href="/app/agents/recruiter/onboarding-readiness" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            View onboarding in Recruiter
          </Link>
        </Card>
        <Card className="gap-2 p-4">
          <p className="text-sm font-semibold text-strong">Cleaners</p>
          <p className="text-sm text-muted-foreground">The shared record: profiles, availability, time off, skills, service areas and documents.</p>
          <Link href="/app/cleaners" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Open Cleaners
          </Link>
        </Card>
        <Card className="gap-2 p-4">
          <p className="text-sm font-semibold text-strong">Dispatch</p>
          <p className="text-sm text-muted-foreground">Whether a ready cleaner can take a specific visit: offers, coverage, reminders and check-ins.</p>
          <Link href="/app/agents/dispatch" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            View assignments in Dispatch
          </Link>
        </Card>
      </div>
    </div>
  );
}
