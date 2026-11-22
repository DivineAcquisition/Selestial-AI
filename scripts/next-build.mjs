#!/usr/bin/env node
/**
 * Run by `npx convex deploy --cmd` on the production build (scripts/build.mjs): makes sure the app connects
 * on the deployment's own client address (scripts/convex-address.mjs), then runs `next build`.
 */
import { spawnSync } from "node:child_process";

import { clientAddress } from "./convex-address.mjs";

const chosen = await clientAddress({ given: process.env.NEXT_PUBLIC_CONVEX_URL, deployKey: process.env.CONVEX_DEPLOY_KEY, fallbackName: process.env.SELESTIAL_PRODUCTION_DEPLOYMENT, fetchImpl: fetch });
for (const line of chosen.log) console.log(line);
if (!chosen.url) process.exit(1);
const result = spawnSync("npx", ["next", "build"], { stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_CONVEX_URL: chosen.url } });
process.exit(result.status ?? 1);
