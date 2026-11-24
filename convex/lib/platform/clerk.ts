/**
 * What a Clerk webhook says, in the shape Selestial uses (clerk.com/docs/guides/development/webhooks).
 * Clerk sends `{ type, data, object: "event", timestamp, instance_id }`, signed with Svix and delivered at
 * least once, so the Svix delivery id is the dedupe key.
 *
 * `sms.created` (clerk.com/docs/guides/customizing-clerk/email-sms-templates): Clerk wants an SMS sent.
 * With "Delivered by Clerk" off for that template, Selestial sends `message` (Clerk's rendered text, its
 * code included) exactly as written, to `to_phone_number`. With it on, Clerk sends it and Selestial does
 * nothing. The payload is never logged or stored.
 */
/**
 * Whether Clerk's SMS carries a one-time code: its template says so (verification_code, reset_password_code and
 * their variants), or its words hold a 4–8 digit number. When in doubt it is treated as a code, so its words are
 * never stored and it goes from the code sender.
 */
export function isClerkCode(slug: string, message = ""): boolean {
  return /(^|_)code(_|$)/.test(slug) || /\b\d{4,8}\b/.test(message);
}

export type ClerkEvent =
  | { kind: "sms"; to: string; message: string; deliveredByClerk: boolean; userId: string | null; slug: string }
  | { kind: "ignored"; type: string };

const s = (value: unknown, max = 200): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

export function clerkEvent(body: string): ClerkEvent {
  let parsed: { type?: unknown; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { kind: "ignored", type: "unreadable" };
  }
  const type = s(parsed.type) ?? "unknown";
  const data = parsed.data ?? {};
  if (type === "sms.created") {
    const to = s(data.to_phone_number, 20);
    const message = s(data.message, 1600);
    if (!to || !message) return { kind: "ignored", type };
    return { kind: "sms", to, message, deliveredByClerk: data.delivered_by_clerk !== false, userId: s(data.user_id), slug: s(data.slug, 80) ?? "sms" };
  }
  return { kind: "ignored", type };
}
