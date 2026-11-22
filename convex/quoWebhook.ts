/** The connection a Quo webhook address names, when it is a real connection id. */
import { v } from "convex/values";

import { internalQuery } from "./_generated/server";

export const connectionFor = internalQuery({
  args: { raw: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("quoConnections", args.raw.replace(/\/+$/, ""));
    return id && (await ctx.db.get(id)) ? id : null;
  },
});
