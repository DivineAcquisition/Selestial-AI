/**
 * Throwing away an upload a link page handed in but that is not being kept (a duplicate, the wrong type, too big).
 *
 * The storage id comes from the person holding the link, so it proves nothing about who uploaded the file. A
 * cleaner or applicant could hand in the id of a photo or file that is already someone's record and have it
 * deleted. So an upload is discarded only when it is recent and nothing has kept it: evidence on any job and
 * files on any application are left exactly as they are.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Longer than any upload-then-attach takes, shorter than a record anyone relies on. */
const FRESH_MS = 2 * 60 * 60 * 1000;

export async function discardUpload(ctx: MutationCtx, storageId: Id<"_storage">): Promise<boolean> {
  const file = await ctx.db.system.get(storageId);
  if (!file) return false;
  if (Date.now() - file._creationTime > FRESH_MS) return false;
  const evidence = await ctx.db
    .query("evidence")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (evidence) return false;
  const attachment = await ctx.db
    .query("applicantAttachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (attachment) return false;
  await ctx.storage.delete(storageId);
  return true;
}
