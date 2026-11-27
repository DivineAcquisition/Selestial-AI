"use server";

import { createHash, randomBytes } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { serverBackendUrl } from "@/lib/app/server-backend";
import { AUTH, withNext } from "@/lib/auth/routes";
import { hostMap, hrefFor } from "@/lib/hosts";

import { api } from "../../../convex/_generated/api";
import type { StartClaimResult } from "../../../convex/founding";

export type ClaimState = { status: "idle" } | { status: "invalid" | "closed" | "limited" | "failed" | "unconfigured" };

/** Where a started claim continues: account creation (or sign-in), then the claim inside the workspace. */
export async function claimDestination(claimKey: string): Promise<string> {
  return hrefFor(withNext(AUTH.signup, `/app/founding?claim=${encodeURIComponent(claimKey)}`), hostMap(process.env));
}

async function visitorKey(): Promise<string> {
  const list = await headers();
  const address = list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 32);
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").slice(0, 200);

/**
 * Starts a founding claim and sends the person on to create their account. It never reports a claim that
 * was not saved, and a saved claim is only answers: the founding place is decided at checkout.
 */
export async function startFoundingClaim(_previous: ClaimState, form: FormData): Promise<ClaimState> {
  // Never the live backend from a preview (src/lib/app/server-backend.ts).
  const url = serverBackendUrl();
  const secret = process.env.PUBLIC_FORM_SECRET?.trim();
  if (!url || !secret) return { status: "unconfigured" };
  const claimKey = randomBytes(24).toString("base64url");
  let result: StartClaimResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new ConvexHttpClient(url);
    result = await Promise.race([
      client.mutation(api.founding.startClaim, {
        secret,
        claimKey,
        companyName: field(form, "companyName"),
        currentSoftware: field(form, "currentSoftware"),
        teamSize: field(form, "teamSize"),
        priority: field(form, "priority"),
        attribution: { source: field(form, "utm_source") || undefined, medium: field(form, "utm_medium") || undefined, campaign: field(form, "utm_campaign") || undefined },
        visitorKey: await visitorKey(),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), 8000);
      }),
    ]);
  } catch {
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
  }
  if (result.status !== "started") return { status: result.status };
  redirect(await claimDestination(result.claimKey));
}
