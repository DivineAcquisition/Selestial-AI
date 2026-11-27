"use client";

/**
 * The bar on top of a page setup sent the owner to (an integration, an import, a draft, an approval) while
 * setup is still in progress. "Return to setup" goes back to the stage they were on, with everything they
 * saved. It works the same after an OAuth redirect, a reload or in a new tab, because the stage comes
 * from the server, not from this browser.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { useCompany } from "@/components/app/company";
import { ArrowLeft } from "@/components/icons";
import { Button } from "@/components/ui/button";

import { api } from "../../../../convex/_generated/api";
import { setupDestination, type HandoffKind } from "../../../../convex/lib/setup/routes";

const WORDS: Record<HandoffKind, string> = {
  integration: "connecting a tool",
  inbox: "connecting your hiring inbox",
  import: "importing records",
  migration: "bringing your business in",
  records: "adding a record",
  review: "reviewing a draft",
  approvals: "reviewing approvals",
  billing: "setting up billing",
  texting: "setting up business texting",
  help: "reading a guide",
};

/** OAuth providers return here with the outcome in the address; failures are recorded for the funnel. */
const FAILED = new Set(["failed", "expired", "declined", "error", "denied"]);

export function ReturnToSetup() {
  const { companyId } = useCompany();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = useQuery(api.setup.state, { companyId });
  const record = useMutation(api.setup.handoff);
  const told = useRef<string | null>(null);
  const result = params.get("result");
  useEffect(() => {
    if (!result || told.current === `${pathname}:${result}`) return;
    told.current = `${pathname}:${result}`;
    if (FAILED.has(result)) void record({ companyId, href: pathname, phase: "failed" }).catch(() => undefined);
  }, [result, pathname, record, companyId]);
  if (!view?.setup || view.setup.status !== "in_progress") return null;
  const kind = setupDestination(pathname);
  const step = view.setup.handoff?.step ?? view.setup.step;
  return (
    <div className="border-b border-brand-500/20 bg-[#eee8ff]" role="region" aria-label="Setup in progress">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2 text-sm sm:px-6">
        <p className="min-w-0 flex-1 text-[#211a35]">
          <span className="font-medium">Your setup is saved.</span> {kind ? `You’re ${WORDS[kind]}. ` : ""}Come back whenever you&apos;re ready{result && FAILED.has(result) ? ": the connection didn't finish, and you can continue setup without it." : "."}
        </p>
        <Button
          variant="primary"
          size="sm"
          render={<Link href={`/app/setup?step=${encodeURIComponent(step)}&from=handoff`} />}
          onClick={() => void record({ companyId, href: pathname, phase: "returned" }).catch(() => undefined)}
        >
          <ArrowLeft aria-hidden />
          Return to setup
        </Button>
      </div>
    </div>
  );
}
