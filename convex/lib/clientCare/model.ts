/**
 * Where a model may help Care, and only here: reading one client message into the same Reading the
 * rules produce. It has no tools and writes nothing; it never chooses a time, a price, a scope or what Care
 * does. Its reading is checked against the message and against the rules (read.ts `checkedReading`): dates
 * and times always come from the rules.
 *
 * CARE_MODEL picks the reader: "claude" (claude.ts, needs ANTHROPIC_API_KEY), "mock" for tests, anything
 * else the rules. The Claude reader runs only with credits held for the `care_message_reading` task, which
 * has no approved price on the production card yet: until the Owner sets one, the rules read and nothing is
 * charged. NOT VERIFIED against the live API in this build.
 */
import { claudeCareModel } from "./claude";
import { readByRule, type Reading } from "./read";

export type ReadInput = { text: string; now: number; timezone: string };

export interface CareModel {
  name: string;
  read(input: ReadInput): Promise<Reading>;
}

export const rulesCareModel: CareModel = {
  name: "rules",
  async read(input) {
    return readByRule(input.text, input.now, input.timezone);
  },
};

/** What the mock model answers, for tests. Unset falls back to the rules. */
export const mockCareModel: { read: ((input: ReadInput) => Reading) | null; calls: number; fail: boolean } = { read: null, calls: 0, fail: false };

const mock: CareModel = {
  name: "mock",
  async read(input) {
    mockCareModel.calls += 1;
    if (mockCareModel.fail) throw new Error("mock reader failed");
    return mockCareModel.read ? mockCareModel.read(input) : { ...readByRule(input.text, input.now, input.timezone), reader: "mock" };
  },
};

export function careModel(force?: "rules"): CareModel {
  if (force === "rules") return rulesCareModel;
  const choice = process.env.CARE_MODEL;
  if (choice === "mock") return mock;
  if (choice === "claude" && process.env.ANTHROPIC_API_KEY) return claudeCareModel(process.env.ANTHROPIC_API_KEY);
  return rulesCareModel;
}
