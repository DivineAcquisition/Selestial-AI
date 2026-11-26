"use server";

import { createHmac } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { headers } from "next/headers";

import { serverBackendUrl } from "@/lib/app/server-backend";

import { api } from "../../../convex/_generated/api";

/**
 * Starting an application on a company's public page goes through Selestial's own server, which adds a
 * keyed hash of the visitor's network address (never the address) for rate limits, and the secret it
 * shares with Convex. Nothing else passes through here.
 */
function client(): { client: ConvexHttpClient; secret: string } | null {
  const url = serverBackendUrl();
  const secret = process.env.PUBLIC_FORM_SECRET?.trim();
  if (!url || !secret) return null;
  return { client: new ConvexHttpClient(url), secret };
}

async function visitorKey(secret: string): Promise<string> {
  const list = await headers();
  const address = list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip")?.trim() || "unknown";
  return createHmac("sha256", secret).update(`apply:${address}`).digest("hex").slice(0, 40);
}

function why(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (data && typeof data.message === "string") return data.message;
  }
  return "That didn't go through. Please try again.";
}

export type StartResult = { ok: true; token: string } | { ok: true; checkEmail: string } | { ok: false; why: string };

export async function startApplication(input: { handle: string; slug: string; name: string; email: string; website: string }): Promise<StartResult> {
  const c = client();
  if (!c) return { ok: false, why: "Online applications aren't available right now. Please contact the company." };
  try {
    const result = await c.client.mutation(api.applyPublic.start, { secret: c.secret, handle: input.handle.slice(0, 60), slug: input.slug.slice(0, 60), name: input.name.slice(0, 200), email: input.email.slice(0, 200), website: input.website.slice(0, 200), visitorKey: await visitorKey(c.secret) });
    if ("refused" in result) return { ok: false, why: result.refused as string };
    if ("checkEmail" in result) return { ok: true, checkEmail: result.checkEmail as string };
    return { ok: true, token: result.token };
  } catch (error) {
    return { ok: false, why: why(error) };
  }
}
