import { loadFoundingView } from "@/lib/founding/status";

/**
 * The live founding status for the page's countdown and counter: the shared deadline, the server's time
 * (so a visitor's wrong clock never changes the deadline) and aggregate counts. No personal data.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const view = await loadFoundingView();
  return Response.json(view, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
