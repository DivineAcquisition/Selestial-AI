import { describe, expect, it } from "vitest";

import { readByRule, withholdAccess } from "./read";

// Wednesday, November 25, 2026, 10:00 in Chicago.
const NOW = Date.UTC(2026, 10, 25, 16, 0);
const TZ = "America/Chicago";
const read = (text: string) => readByRule(text, NOW, TZ);
const categories = (text: string) => read(text).intents.map((i) => i.category);

describe("Care's rules reader", () => {
  it("reads appointment questions without inventing anything", () => {
    expect(read("When are you coming on Friday?").intents[0]).toMatchObject({ category: "appointment", ask: { question: "when", target: { day: "2026-11-27", weekday: 5 } } });
    expect(read("Who is assigned to my cleaning?").intents[0].ask.question).toBe("who");
    expect(read("What's included in the standard clean?").intents[0].ask.question).toBe("included");
    expect(read("Has my cleaning been confirmed?").intents[0].ask.question).toBe("confirmed");
  });

  it("keeps the visit to move apart from the day it moves to", () => {
    const [intent] = read("Can you move Friday's cleaning to Monday?").intents;
    expect(intent.category).toBe("reschedule");
    expect(intent.ask.target).toMatchObject({ day: "2026-11-27", weekday: 5 });
    expect(intent.ask.when).toMatchObject({ day: "2026-11-30", weekday: 1 });
    expect(read("Please reschedule to Tuesday at 10am").intents[0].ask.when).toMatchObject({ weekday: 2, minute: 600 });
  });

  it("never reads 'cancel Friday' as ending the plan", () => {
    expect(read("Cancel Friday please").intents[0]).toMatchObject({ category: "cancellation", ask: { cancel: "skip_visit", target: { weekday: 5 } } });
    expect(read("Please skip next week's cleaning").intents[0].ask.cancel).toBe("skip_visit");
    expect(read("I want to cancel my service").intents[0].ask.cancel).toBe("end_plan");
    expect(read("We're on vacation, please pause until Dec 15").intents[0]).toMatchObject({ ask: { cancel: "pause_plan", when: { day: "2026-12-15" } } });
    // "Cancel" with nothing to say which: no kind, so Care asks.
    expect(read("I need to cancel").intents[0].ask.cancel).toBeUndefined();
  });

  it("reads two requests in one message", () => {
    expect(categories("Can we move Friday to Monday? Also please skip the guest bedroom this time.").sort()).toEqual(["preference", "reschedule"]);
  });

  it("reads a preference's scope only when the client says it", () => {
    expect(read("Please avoid fragrance products from now on").intents[0]).toMatchObject({ category: "preference", ask: { scope: "all_future" } });
    expect(read("Don't clean the guest bedroom this Friday only").intents[0].ask.scope).toBe("one_visit");
    expect(read("Please use unscented products").intents[0].ask.scope).toBeUndefined();
  });

  it("withholds access codes from what is kept", () => {
    const r = read("The gate code changed to 4821#");
    expect(r.access).toBe(true);
    expect(r.intents[0].category).toBe("access");
    expect(r.intents[0].ask.detail).not.toContain("4821");
    expect(withholdAccess("Door code is now 7788 and the spare key is under the blue pot.").text).toBe("Door code is now [withheld] and the spare key is under [withheld].");
  });

  it("reads complaints, and serious words as serious", () => {
    expect(read("The bathroom still looks dirty").intents[0].category).toBe("complaint");
    expect(read("The bathroom still looks dirty").areas).toEqual(["bathroom"]);
    expect(read("Your cleaner broke my vase").serious).not.toBeNull();
  });

  it("reads invoices, extras and new service", () => {
    expect(categories("Can you send my invoice?")).toEqual(["billing"]);
    expect(categories("I paid yesterday, can you check?")).toEqual(["billing"]);
    expect(categories("Can you add inside the oven on Friday?")).toContain("extra");
    expect(categories("Can I get a quote for my office?")).toEqual(["new_service"]);
  });

  it("knows thanks from a request, and reads short answers", () => {
    expect(read("Thanks!").ack).toBe(true);
    expect(read("Thanks!").intents).toEqual([]);
    expect(read("ok 👍").ack).toBe(true);
    expect(read("2").answer).toMatchObject({ choice: 2 });
    expect(read("The second one").answer).toMatchObject({ choice: 2 });
    expect(read("Yes please").answer).toMatchObject({ yes: true });
    expect(read("Just that one visit").answer).toMatchObject({ cancel: "skip_visit" });
    expect(read("The whole plan").answer).toMatchObject({ cancel: "end_plan" });
    expect(read("Monday at 9am works").answer).toMatchObject({ weekday: 1, minute: 540 });
  });
});
