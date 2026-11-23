/**
 * A stateful fake of Quo's API (https://www.quo.com/docs, 2026-03-30) for tests: numbers, the workspace's carrier
 * registration, webhooks with a real `whsec_` signing key, sending and listing messages. Nothing reaches Quo.
 *
 * `send` decides what the next POST /messages does: "ok", "timeout_after_accept" (Quo takes it, the answer is lost),
 * "timeout" (Quo never got it), or an HTTP failure.
 */
import { signForTest, type QuoEvent } from "../convex/lib/quo/api";

export type FakeSend = "ok" | "timeout_after_accept" | "timeout" | 401 | 402 | 429 | "opted_out" | "a2p";

export const QUO_NUMBER = { id: "PNmain0001", phoneNumber: "+15125550100", name: "Main line" };
export const QUO_SECOND = { id: "PNsecond02", phoneNumber: "+15125550200", name: "Hiring" };

export function fakeQuo(options: { registration?: "approved" | "pending" | "none"; key?: string } = {}) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; key: string | null }[] = [];
  const messages: { id: string; to: string[]; from: string; text: string; phoneNumberId: string; conversationId: string; direction: "incoming" | "outgoing"; userId: string | null; status: string; createdAt: string }[] = [];
  const webhooks: { id: string; url: string; resourceIds: string[]; key: string }[] = [];
  const state = { send: "ok" as FakeSend, key: options.key ?? "quo_test_key_0123456789", registration: options.registration ?? "approved", numbers: [QUO_NUMBER, QUO_SECOND], sequence: 0 };
  const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, title: string) => json({ title, message: title, docs: "https://www.quo.com/docs", trace: "trace-123" }, status);

  const fetcher = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname, body, key: headers.get("authorization") });
    if (url.hostname !== "api.quo.com") return error(404, "Not Found");
    if (headers.get("quo-api-version") !== "2026-03-30") return error(400, "Missing Quo-Api-Version");
    if (headers.get("authorization") !== state.key) return error(401, "Unauthorized");

    if (method === "GET" && url.pathname === "/phone-numbers") return json({ data: state.numbers.map((n) => ({ ...n, groupId: "GR1", formattedNumber: n.phoneNumber, restrictions: { messaging: { US: "unrestricted", CA: "unrestricted", Intl: "restricted" } } })), nextCursor: null });
    if (method === "GET" && url.pathname === "/a2p-registration") return state.registration === "none" ? error(404, "Not Found") : json({ data: { id: "RG1", draft: false, status: state.registration } });
    if (method === "POST" && url.pathname === "/webhooks") {
      const key = `whsec_${btoa("fake-quo-signing-key-32-bytes!!!")}`;
      const row = { id: String(1000 + webhooks.length), url: String(body!.url), resourceIds: (body!.resourceIds as string[]) ?? ["*"], key };
      webhooks.push(row);
      return json({ data: { ...row, events: body!.events, orgId: "OR1", status: "enabled", label: "Selestial" } }, 201);
    }
    if (method === "PATCH" && url.pathname.startsWith("/webhooks/")) {
      const row = webhooks.find((w) => w.id === url.pathname.split("/")[2]);
      if (!row) return error(404, "Webhook not found");
      row.resourceIds = (body!.resourceIds as string[]) ?? row.resourceIds;
      return json({ data: row });
    }
    if (method === "DELETE" && url.pathname.startsWith("/webhooks/")) {
      const index = webhooks.findIndex((w) => w.id === url.pathname.split("/")[2]);
      if (index < 0) return error(404, "Webhook not found");
      webhooks.splice(index, 1);
      return json(null, 204);
    }
    if (method === "POST" && url.pathname === "/messages") {
      const mode = state.send;
      if (mode === 401) return error(401, "Unauthorized");
      if (mode === 402) return error(402, "Not Enough Credits");
      if (mode === 429) return error(429, "Too Many Requests");
      if (mode === "opted_out") return error(400, "User Opted Out");
      if (mode === "a2p") return error(400, "A2P Registration Not Approved");
      if (mode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      const row = outgoing(String(body!.from), (body!.to as string[])[0], String(body!.content), null);
      if (mode === "timeout_after_accept") throw new DOMException("The operation timed out.", "TimeoutError");
      return json({ data: row }, 202);
    }
    if (method === "GET" && url.pathname === "/messages") {
      const since = url.searchParams.get("createdAt[gt]");
      const direction = url.searchParams.get("direction");
      const to = url.searchParams.get("to");
      const from = url.searchParams.get("from");
      const rows = messages.filter(
        (m) =>
          m.phoneNumberId === url.searchParams.get("phoneNumberId") &&
          (!since || m.createdAt > since) &&
          (!direction || m.direction === direction) &&
          (!to || m.to.includes(to)) &&
          (!from || m.from === from),
      );
      return json({ data: [...rows].reverse(), nextCursor: null });
    }
    return error(404, "Not Found");
  };

  function outgoing(fromNumberId: string, to: string, text: string, userId: string | null) {
    state.sequence += 1;
    const number = state.numbers.find((n) => n.id === fromNumberId)!;
    const row = { id: `AC${String(state.sequence).padStart(8, "0")}`, to: [to], from: number.phoneNumber, text, phoneNumberId: fromNumberId, conversationId: `CN${to.slice(-4)}`, direction: "outgoing" as const, userId: userId ?? "USowner01", status: "queued", createdAt: new Date().toISOString() };
    messages.push(row);
    return row;
  }

  /** A text someone sent from the Quo app (not through the API). */
  function humanSends(fromNumberId: string, to: string, text: string) {
    return outgoing(fromNumberId, to, text, "UShuman02");
  }

  /** A text the person sends to a Quo number. */
  function incoming(toNumberId: string, from: string, text: string) {
    state.sequence += 1;
    const number = state.numbers.find((n) => n.id === toNumberId)!;
    const row = { id: `AC${String(state.sequence).padStart(8, "0")}`, to: [number.phoneNumber], from, text, phoneNumberId: toNumberId, conversationId: `CN${from.slice(-4)}`, direction: "incoming" as const, userId: null, status: "received", createdAt: new Date().toISOString() };
    messages.push(row);
    return row;
  }

  /** The webhook event Quo would send for a message, signed with the webhook's key. */
  async function event(type: "message.received" | "message.delivered" | "message.failed" | "message.undelivered", message: (typeof messages)[number], options: { eventId?: string; orgId?: string; webhook?: number; secretOverride?: string } = {}) {
    const hook = webhooks[options.webhook ?? webhooks.length - 1];
    const payload: QuoEvent & { id: string; apiVersion: string } = {
      id: options.eventId ?? `EV${message.id}${type}`,
      apiVersion: "2026-03-30",
      createdAt: new Date().toISOString(),
      type,
      data: {
        resource: { id: message.id, direction: message.direction, text: message.text, status: type === "message.received" ? "received" : type.split(".")[1], createdAt: message.createdAt, errorCode: type === "message.failed" ? "30007" : null },
        context: { orgId: options.orgId ?? "OR1", phoneNumberId: message.phoneNumberId, conversationId: message.conversationId, userId: message.userId, senderIdentifier: message.from, recipientIdentifiers: message.to },
        links: { quo: null },
      },
    };
    const body = JSON.stringify(payload);
    const id = payload.id;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signForTest(options.secretOverride ?? hook.key, id, timestamp, body);
    const path = new URL(hook.url).pathname;
    return { path, init: { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature }, body } };
  }

  return { fetcher, calls, messages, webhooks, state, humanSends, incoming, event, posts: () => calls.filter((c) => c.method === "POST" && c.path === "/messages") };
}
