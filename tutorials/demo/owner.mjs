#!/usr/bin/env node
/**
 * A fresh demo owner, signed in, with no company yet:
 *   node tutorials/demo/owner.mjs <label>
 * Writes tutorials/.auth/<label>.json (browser session) and tutorials/.auth/<label>.person.json (identity
 * for `convex run --identity`). Both are git-ignored.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeOwner, ROOT, signIn } from "./lib.mjs";

const label = process.argv[2] ?? "demo-owner";
const dir = join(ROOT, "tutorials/.auth");
mkdirSync(dir, { recursive: true });
const person = await makeOwner(label);
await signIn(person, join(dir, `${label}.json`));
writeFileSync(join(dir, `${label}.person.json`), JSON.stringify({ id: person.id, email: person.email, identity: person.identity }, null, 1));
console.log(`Signed in ${person.email} → tutorials/.auth/${label}.json`);
