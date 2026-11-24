# QuickBooks Online

The Owner connects the company's QuickBooks Online company from **Settings › Connected apps › QuickBooks**
(`/app/settings/integrations/quickbooks`). Today the connection is made, checked (the company's name is read
back) and kept working. Syncing customers, invoices and payments is the next step; nothing is written to
QuickBooks yet.

Code: `convex/quickbooks.ts` (functions), `convex/lib/quickbooks/oauth.ts` (configuration, discovery, token
calls), `convex/lib/quickbooks/api.ts` (accounting API calls and retries), `convex/lib/quickbooks/schema.ts`
(tables), `src/components/app/screens/quickbooks-setup.tsx` (screen), tests in `convex/quickbooks.test.ts`.

## How it works

| Concern | What Selestial does |
|---|---|
| Endpoints | Read from Intuit's discovery document (`/.well-known/openid_configuration`, or `openid_sandbox_configuration`), cached for a day and kept in `quickbooksDiscovery` so the sign-in address can be built in a mutation. Only `*.intuit.com` addresses are accepted. Intuit's documented defaults are used only before the first read. |
| Sign-in (CSRF) | `startConnect` (Owner only) issues a random one-time `state`; only its hash is stored, for ten minutes. The callback refuses a missing, unknown, reused or expired state before exchanging anything, and checks the person is still the Owner. |
| Tokens | The code is exchanged with HTTP Basic auth (client id and secret). Both tokens are sealed with `MAILBOX_TOKEN_KEY`, bound to the connection id. Nothing reaches a browser. |
| Refreshing | The access token (about an hour) is reused until five minutes before it expires, then refreshed. Intuit's newest refresh token is stored before anything else, every time. |
| Expired access token | A 401 from the API: refresh once and try the call again. |
| Expired or revoked refresh token | `invalid_grant`: the connection becomes `needs_reconnect`, the tokens are deleted, and the Owner gets a "Reconnect QuickBooks" card on Home and Connected apps (operations check `quickbooks`). |
| Transient failures | Network errors, 429 and 5xx are retried up to three times (0.5s, 1s, 2s, or longer when Intuit sends `Retry-After`). Errors carry Intuit's `intuit_tid` for support. |
| Reconnecting | The same sign-in. The same QuickBooks company brings the same connection back; a different one replaces it and the old authorization is revoked. |
| Disconnecting | Owner only. The tokens are deleted and the authorization is revoked at Intuit's revocation endpoint. Company deletion does the same. |
| Disconnected in QuickBooks | Intuit's "Disconnect URL" is `/quickbooks/disconnected` (public). Intuit has already ended access; Selestial notices on the next call (`invalid_grant`) and asks the Owner to reconnect. |

No OAuth Playground or offline tool is used: every token comes from the Owner's own sign-in.

## Setting it up

1. In the Intuit Developer portal, create an app with the **Accounting** scope (`com.intuit.quickbooks.accounting`).
2. Redirect URI (Development and Production): `https://app.selestial.io/oauth/quickbooks/callback`
   (passed straight through to the backend by `next.config.ts`), or the backend's own
   `https://<deployment>.convex.site/oauth/quickbooks/callback`.
3. Disconnect URL: `https://www.selestial.io/quickbooks/disconnected`. Launch URL / Connect URL:
   `https://app.selestial.io/app/settings/integrations/quickbooks`. Privacy policy:
   `https://www.selestial.io/privacy`. EULA: `https://www.selestial.io/eula`.
4. On the Convex deployment (`npx convex env set`):

| Variable | Value |
|---|---|
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | The app's Development keys (sandbox) or Production keys |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` (default) or `production`, matching the keys |
| `QUICKBOOKS_REDIRECT_URI` | Optional: `https://app.selestial.io/oauth/quickbooks/callback` |
| `MAILBOX_TOKEN_KEY` | Already set for Google; seals the QuickBooks tokens too |

Without the client id and secret the screen says QuickBooks isn't available and nothing is attempted.

## Testing with a sandbox company

With `QUICKBOOKS_ENVIRONMENT=sandbox` and the Development keys, connect from the screen, sign in with the
Intuit developer account and choose the sandbox company. Then: **Check connection** (reads the company name),
**Disconnect** (revokes at Intuit), and connect again. To test reconnecting after Intuit ends access,
disconnect Selestial from inside the sandbox company's Apps page; the next check marks it "needs
reconnecting" and the reconnect card appears.
