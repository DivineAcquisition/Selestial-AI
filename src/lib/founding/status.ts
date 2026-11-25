import "server-only";

import { ConvexHttpClient } from "convex/browser";

import { convexUrl } from "@/lib/app/config";

import { api } from "../../../convex/_generated/api";
import type { PublicFoundingStatus } from "../../../convex/founding";
import { viewFrom, type FoundingView } from "./view";

/**
 * Reads the public founding status from the backend, with the web server's own clock. If the backend can't
 * be reached the view says "unavailable": no countdown, no count, no claim. Nothing is made up.
 */
export async function loadFoundingView(): Promise<FoundingView> {
  const url = convexUrl();
  let status: PublicFoundingStatus | null = null;
  if (url) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = new ConvexHttpClient(url);
      status = await Promise.race([
        client.query(api.founding.status, {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), 4000);
        }),
      ]);
    } catch {
      status = null;
    } finally {
      clearTimeout(timer);
    }
  }
  return viewFrom(status, Date.now());
}
