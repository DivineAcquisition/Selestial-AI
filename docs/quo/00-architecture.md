# Quo (formerly OpenPhone)

A company that already texts from Quo connects its own account, and Selestial's agents text through the
company's Quo numbers. Selestial keeps the business context, agent decisions, approvals, workflows and history;
Quo carries the texts. Built against Quo's public API, version `2026-03-30` (https://www.quo.com/docs).

Existing Telnyx texting is unchanged: a company's own Selestial number keeps working exactly as before, and a
conversation never moves between providers on its own.

## Connection (`convex/quo.ts`, `convex/lib/quo/schema.ts`)

| State | Means |
|---|---|
| Not connected | No connection row. |
| Setup incomplete | The key was accepted, but something below is missing. |
| Ready | A number is chosen, Quo's webhook is in place, carrier registration is shown by Quo (or confirmed by the Owner), and a test text's reply came back. |
| Degraded | A problem stops sends (no credits, expired subscription, registration, repeated outages, the webhook). Recovery: fix it in Quo, then **Check again**. |
| Disconnected | The Owner disconnected, or Quo rejected the key (deleted or rotated in Quo). Recovery: connect again or replace the key. |

- **Authentication.** Quo's API uses API keys (`Authorization: <key>`, no Bearer) plus `Quo-Api-Version`. It
  documents no OAuth, so none is offered. The Owner makes a key in Quo › Workspace Settings › API (owner or admin
  only) and names it "Selestial".
- **Secrets.** The key is sealed the moment it arrives (`lib/recruiter/secrets.ts`, AES-GCM with
  `MAILBOX_TOKEN_KEY`, bound to the connection) in `quoSecrets`, a table no query returns and that is left out of the
  company export. Only internal actions unseal it. It is never logged, put in an error's words, or given to a model.
  Rotation (`rotateKey`) uses the new key only once Quo accepts it and it sees the same numbers; disconnecting
  deletes Selestial's webhook in Quo (where Quo allows) and then forgets both secrets.
- **Only an Owner** connects, chooses numbers and agents, sends the test, rotates the key or disconnects.
- **Numbers.** `GET /phone-numbers?include=restrictions`. The Owner picks the numbers Selestial may use; a number
  already connected to another company is refused. The first is used for new conversations, and only when the Owner
  turns on "use for new conversations": turning it on first pins every existing conversation to the company's own
  Selestial number.
- **Webhook.** `POST /webhooks` for the chosen numbers only, with events `message.received`, `message.delivered`,
  `message.failed`, `message.undelivered` and `a2p.registration.updated`, pointing at
  `https://<deployment>.convex.site/webhooks/quo/<connection id>`. Its `whsec_` key is sealed like the API key.
  Changing the numbers updates it (`PATCH`).
- **Registration.** `GET /a2p-registration` is the workspace's 10DLC registration: Quo reports it for the workspace,
  not per number. When Quo shows none (a toll-free number, verified separately), the Owner may confirm it; the
  screens say it was confirmed by the Owner, not verified by Selestial.
- **Test.** The Owner sends one text to a number they say is their own (five an hour at most). Their reply, arriving
  through the webhook, sets `replyVerifiedAt`. Until then no agent texts through Quo.
- **Agents.** The Owner chooses which of Sales, Recruiter, Dispatch and Retention may text through Quo. Each shows its
  audience, sender, trigger, approval mode (from its real permission level) and behaviour before it is allowed.

## Routing (`convex/lib/quo/route.ts`)

One `smsConversations` row per company and phone number, for either provider. Its route (provider and number) is
fixed by its first text. Only an Owner moves it (`smsConversations.changeRoute`). A new conversation uses Quo when
the connection is used for new conversations, otherwise the company's own Selestial number. If its route can't send
(Quo not ready, the number unselected, the agent not allowed), the text is refused with the reason. It is never sent
through another provider or number.

## Sending (`convex/messaging.ts`, `convex/lib/quo/send.ts`)

Agents still ask the shared outbox. The same policy runs at planning and at sending time: suspension, agent pause,
route readiness, conversation owner, suppression, permission, quiet hours and frequency
(`lib/messaging/policy.ts`). Texts through Quo are free in Selestial's messaging billing, because the company pays
Quo. No pricing or entitlement changed.

- Immediately before an agent's **conversational** text goes, Quo is asked for the conversation since the text was
  written. A text from the Quo app, or a newer reply, wins: nothing is sent, and the reason is recorded.
  Standardized operational texts (offers, reminders, confirmations) skip this check.
- `POST /messages` (`from` is the `PN…` id). 202 is **accepted**, never "delivered"; delivery comes from Quo's event.
- Errors: 429 and 5xx are retried (bounded). 402 (credits, subscription), A2P refusals and the daily cap degrade the
  connection and tell the Owner (`quo_attention`). 401 disconnects. "User Opted Out" becomes Selestial's own
  suppression.
- **No answer** (timeout): Quo has no idempotency key, so the text is left unconfirmed and checked against
  `GET /messages` for that number and person (`convex/quoSend.ts`). Exactly one unmatched text there settles it as
  sent. None after three checks: not sent, and it is **not** resent on its own. More than one: a person decides.

## Receiving (`convex/http.ts`, `convex/lib/quo/events.ts`, `convex/inbound.ts`)

- The address names the connection. The signature is checked with that connection's own secret: HMAC-SHA256 over
  `{webhook-id}.{webhook-timestamp}.{raw body}`, `v1,` entries in `webhook-signature`, five minutes' tolerance.
  The event's number must be one this company's key sees, and its workspace the first one seen. Any other event is
  refused or ignored.
- Each event is handled once (deduped on `webhook-id`) in one transaction. If handling fails, Quo is answered with an
  error and retries for about a day, so a temporary failure loses no reply.
- A reply goes through the **same** inbound path as a text to a Selestial number: STOP, HELP and START; Sales
  inquiries; a person's task for customers (Retention), applicants (Recruiter) and cleaners (Dispatch, with the reply
  read against the cleaner's own visits, and nothing assigned until the job is checked again); the client's
  conversation; Retention's reading. A number on no record that Sales doesn't take goes to the review queue, with a
  task. Replies are received and routed even while agents are paused.
- Delivery events match Selestial's texts by Quo's id. One that beats the send's own answer is kept and applied when
  it settles. Delivered is final.

## Conversation ownership (`convex/smsConversations.ts`, Inbox)

Owner: the agents (each in its own workflow), a person, someone in the Quo app, or the review queue. **Take over**,
**Pause agent replies**, **Assign** (managers), **Return to agent**, each with its reason. An outgoing Quo text that
isn't Selestial's (from its delivery event, or found by the pre-send recheck) sets the owner to "someone in the Quo
app". The Inbox (`/app/inbox`) shows every conversation from either provider with linked records, sender and
provider, owner, delivery status and business outcome, kept apart ("Delivered to the phone" vs "Cleaner accepted the
job"), open tasks, and connection problems.

## Configuration still required

1. `MAILBOX_TOKEN_KEY` (already set on production) seals the key. `CONVEX_SITE_URL` is set by Convex.
2. Each company: a Quo workspace where they are owner or admin, an API key, an approved carrier registration in Quo,
   and Quo auto-replies and AI agents (Sona) off on the numbers they give Selestial.
3. Selestial: complete Quo's developer registration and review its Developer API Terms of Service. They require
   "Powered by OpenPhone" attribution and written approval before the integration is monetized. Add Quo's official
   logo to `public/integrations/` once supplied.

## Limitations (shown to the Owner)

- Registration is per workspace, not per number.
- Whether texts sent from the Quo app emit `message.delivered` isn't documented. The pre-send recheck catches them
  regardless, before any agent's conversational text.
- Quo exposes no opt-out state or event. Its "User Opted Out" refusal is mirrored into Selestial's own suppressions.
  Whether Quo also answers STOP itself isn't documented, so Selestial's own STOP confirmation may be a second one.
- No documented deep-link format for a conversation, so none is shown.
