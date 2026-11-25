/**
 * The images a company uploads for what its customers see: booking pages and email branding.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { MemberAccess } from "../builders";
import { userError } from "../errors";

const IMAGE_TYPES = /^image\/(png|jpe?g|webp)$/;
const FRESH_UPLOAD = 60 * 60_000;

/**
 * Registers an uploaded image to this company, or confirms it is already this company's. Used for the
 * booking pages' logo and hero, and for the logo in email branding (convex/emailBranding.ts). A stored file
 * has no owner of its own, so an id is only accepted when it was uploaded within the hour and nothing
 * (another company's booking page, Creative Studio, Agreements, receipts, Chat) has claimed it. SVG is
 * refused: it can carry script, and these images are shown to the public.
 */
export async function claimImage(ctx: MutationCtx & MemberAccess, storageId: Id<"_storage">): Promise<void> {
  const gone = () => userError("The image wasn't found. Upload it again.");
  const mine = await ctx.db
    .query("bookingImages")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (mine) {
    if (mine.companyId !== ctx.companyId) throw gone();
    return;
  }
  const meta = await ctx.db.system.get(storageId);
  if (!meta) throw gone();
  if (!IMAGE_TYPES.test(meta.contentType ?? "")) throw userError("Use a PNG, JPEG or WebP image.");
  if (meta.size > 2 * 1024 * 1024) throw userError("Use an image under 2 MB.");
  if (meta._creationTime < Date.now() - FRESH_UPLOAD) throw gone();
  for (const table of ["mediaAssets", "agreementFiles", "expenseReceipts", "chatUploads"] as const) {
    const claimed = await ctx.db
      .query(table)
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (claimed) throw gone();
  }
  await ctx.db.insert("bookingImages", { companyId: ctx.companyId, storageId, uploadedBy: ctx.member._id, createdAt: Date.now() });
}

