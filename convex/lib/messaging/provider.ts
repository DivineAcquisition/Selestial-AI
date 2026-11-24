/**
 * The one door every outbound text goes through: Telnyx (convex/lib/messaging/telnyx.ts) or the mock.
 * The mock answers from the number alone, so a test can ask for a delivered message, a failure, a
 * carrier that never confirms, or a send that dies half way.
 */
import { countSegments } from "../messagingBilling/segments";
import { telnyxProvider } from "./telnyx";

/**
 * `from` is the company's texting number. `messagingProfileId` is the company's own Telnyx messaging
 * profile: opt-outs are kept per profile at Telnyx, so a company's texts never ride on another company's
 * profile. The mock ignores both.
 */
export type SendInput = { to: string; from?: string; messagingProfileId?: string; body: string; idempotencyKey: string; attempt: number };

export type SendResult =
  /**
   * The provider took the message. `delivered` is set only when it also confirmed the handset got it.
   * `replayed`: the provider answered with the response it stored for this idempotency key, so the
   * message had already been accepted by an earlier attempt and was not sent again.
   */
  | { ok: true; providerMessageId: string; delivered: boolean; parts?: number; replayed?: boolean }
  /**
   * It did not go. `retryable` means trying again may work. `problem` is words for a person, never a raw
   * response. `uncertain`: the provider holds a different request under this key, so whether the first
   * one went is still not known; the message is left unconfirmed rather than failed.
   * `providerBlock`: the provider refused because the recipient opted out with it (Telnyx 40300). Selestial
   * records that as a suppression, so nothing else is tried to that number from this company.
   */
  | { ok: false; retryable: boolean; problem: string; uncertain?: boolean; providerBlock?: boolean };

export interface MessagingProvider {
  name: string;
  send(input: SendInput): Promise<SendResult>;
}

/** What the mock was asked to send, newest last. For tests only. */
export const mockOutbox: (SendInput & { result: "accepted" | "failed" | "threw" | "replayed" })[] = [];

/**
 * Sends the mock accepted and then lost the answer to (numbers ending 0006). A repeat of the same key, to
 * and body replays the stored answer instead of sending again, as Telnyx does for 24 hours.
 */
const mockAccepted = new Map<string, { to: string; body: string; providerMessageId: string; parts: number }>();

/** For tests: forget what the mock accepted. */
export function resetMockProvider() {
  mockAccepted.clear();
  mockOutbox.length = 0;
}

/**
 * Test numbers, by their last four digits:
 * 0001 never deliverable. 0002 fails twice, then goes. 0003 the send dies with no answer.
 * 0004 accepted, but no delivery report ever comes. 0006 accepted, then the connection dies before the
 * answer (a provider timing out after accepting). 0007 refused because the person opted out with the
 * provider (Telnyx 40300). Anything else is accepted and delivered.
 */
export const mockProvider: MessagingProvider = {
  name: "mock",
  async send(input) {
    const tail = input.to.slice(-4);
    const stored = mockAccepted.get(input.idempotencyKey);
    if (stored && stored.to === input.to && stored.body === input.body) {
      mockOutbox.push({ ...input, result: "replayed" });
      return { ok: true, providerMessageId: stored.providerMessageId, delivered: false, parts: stored.parts, replayed: true };
    }
    if (tail === "0006") {
      mockAccepted.set(input.idempotencyKey, { to: input.to, body: input.body, providerMessageId: `mock-${input.idempotencyKey}`, parts: countSegments(input.body).segments });
      mockOutbox.push({ ...input, result: "accepted" });
      throw new Error("mock: accepted, then the connection timed out");
    }
    if (tail === "0007") {
      mockOutbox.push({ ...input, result: "failed" });
      return { ok: false, retryable: false, providerBlock: true, problem: "This number opted out of texts from this business with the carrier (it replied STOP), so the text was not sent." };
    }
    if (tail === "0003") {
      mockOutbox.push({ ...input, result: "threw" });
      throw new Error("mock: connection lost");
    }
    if (tail === "0001" || (tail === "0002" && input.attempt < 3)) {
      mockOutbox.push({ ...input, result: "failed" });
      return { ok: false, retryable: tail === "0002", problem: tail === "0002" ? "The carrier did not answer." : "The carrier says this number cannot receive texts." };
    }
    mockOutbox.push({ ...input, result: "accepted" });
    // Like Telnyx, the mock reports the billable segment count. Numbers ending 0005 report one more than the
    // local estimate, as a provider counting differently would.
    const parts = countSegments(input.body).segments + (tail === "0005" ? 1 : 0);
    return { ok: true, providerMessageId: `mock-${input.idempotencyKey}`, delivered: tail !== "0004", parts };
  },
};

/** The provider this deployment uses, from MESSAGING_PROVIDER. Null means messaging is not connected. */
export function messagingProvider(): MessagingProvider | null {
  const name = process.env.MESSAGING_PROVIDER?.trim().toLowerCase();
  if (name === "mock") return mockProvider;
  if (name === "telnyx") return telnyxProvider();
  return null;
}

/** A number a text can be sent to, in +digits form, or null. */
export function sendablePhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits.length === 10 ? `1${digits}` : digits}`;
}
