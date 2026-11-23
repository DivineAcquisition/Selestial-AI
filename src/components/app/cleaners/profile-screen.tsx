"use client";

/** A worker's own page: /app/cleaners/<id>/<section>. Each section has its own address to link to. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";

import { useCompany } from "@/components/app/company";
import { ArrowLeft } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";

import { PendingRequests, ProfileActions, ProfileHeader, SectionBody, SectionTabs, useProfile } from "./profile";
import { CLEANERS_PATH, directoryHref, profilePath, type SectionId } from "./state";

const noSubscription = () => () => undefined;

export function CleanerProfileScreen({ cleanerId, section }: { cleanerId: string; section: SectionId }) {
  const profile = useProfile(cleanerId);
  const router = useRouter();
  // The way back keeps the directory's search and filters, read once the page is in the browser.
  const back = useSyncExternalStore(noSubscription, directoryHref, () => CLEANERS_PATH);
  return (
    <div className="grid gap-5">
      <Link href={back} className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
        <ArrowLeft className="size-4" aria-hidden />
        Cleaners
      </Link>
      {profile === undefined ? (
        <div className="grid gap-4" aria-busy="true" aria-label="Loading the profile">
          <div className="flex items-center gap-4">
            <Skeleton className="size-20 rounded-full" />
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-7 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
            <ProfileHeader profile={profile} />
            <div className="lg:max-w-md">
              <ProfileActions profile={profile} />
            </div>
          </div>
          <WhoHandles status={profile.status} hired={profile.hiredFrom !== null} />
          <PendingRequests cleanerId={profile.cleanerId} />
          <SectionTabs cleanerId={cleanerId} active={section} />
          <SectionBody section={section} profile={profile} onSection={(next) => router.push(profilePath(cleanerId, next))} />
        </>
      )}
    </div>
  );
}

/**
 * This workspace holds the record; each next step has one owner. Recruiter prepares a new cleaner, Dispatch
 * coordinates the visits they can take, and Finance keeps their pay. The links say who, without copies.
 */
function WhoHandles({ status, hired }: { status: string; hired: boolean }) {
  const { role } = useCompany();
  const next =
    status === "onboarding"
      ? hired
        ? "Recruiter is handling their onboarding. They're offered no work until an Owner approves their readiness."
        : "They're onboarding. They're offered no work until a person makes the engagement active."
      : status === "ready"
        ? "Dispatch considers them for visits that match their availability, skills and service area, and checks each visit."
        : "They're not offered new work while their engagement is not active.";
  const link = "text-xs font-medium text-muted-foreground underline-offset-2 hover:text-strong hover:underline";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-muted/60 px-3 py-2.5">
      <p className="min-w-0 flex-1 text-xs text-strong">{next}</p>
      {hired ? (
        <Link href="/app/agents/recruiter/applicants?view=onboarding" className={link}>
          View onboarding in Recruiter
        </Link>
      ) : null}
      <Link href="/app/agents/dispatch" className={link}>
        View assignments in Dispatch
      </Link>
      {role === "owner" || role === "manager" ? (
        <Link href="/app/finance?tab=team-pay" className={link}>
          View earnings in Finance
        </Link>
      ) : null}
    </div>
  );
}
