# Heartbeat: knowing when monitoring itself has stopped

Selestial's checks find incidents and email staff (`02-incidents.md`). If the checks stop, or the alert
emails stop going, nothing inside Selestial can say so: the thing that would raise the alarm is the thing
that is broken. `GET /health` exists so something **outside** Selestial can notice.

Code: `convex/operations.ts` (`health`, `sendStaffAlerts`, `recordAlertDelivery`), `convex/http.ts`
(`/health`), `convex/lib/builders.ts` (`selfCheckRoute`). Tests: `convex/operations.test.ts`.

> **Not configured yet. Owner action.** No outside monitor polls `/health` today. Until one does, a stopped
> cron or a revoked email key is only visible to someone who opens `/staff/operations`.

## The address

| Backend | Address |
|---|---|
| Production | `https://stoic-gazelle-731.convex.site/health` |
| Production, custom domain | `https://api.selestial.io/health` |
| Test backend | `https://terrific-avocet-835.convex.site/health` (answers for itself; see below) |

Both production addresses reach the same backend. Monitor the `convex.site` one first: it does not depend on
the custom domain's DNS. Monitoring both also tells you when only the custom domain is down.

## What it answers

| Answer | Meaning |
|---|---|
| `200 {"ok":true}` | Every operations check finished recently, and no staff alert has been waiting more than 20 minutes. |
| `503 {"ok":false,"reasons":[…]}` | One or more of the reason codes below. |
| No answer, a timeout, any other status | The backend or its HTTP routes are down. Treat as failing. |

| Reason code | Meaning | First thing to look at |
|---|---|---|
| `checks_not_run` | A check has never finished on this backend. | Normal for a few minutes after the first deploy. Otherwise: Convex dashboard › Schedules › cron jobs. |
| `checks_stale` | A check has not finished for three of its intervals plus ten minutes. | Convex dashboard › Logs for `operations:runCheck` and `operations:tick`; `/staff/operations` shows which check. |
| `alerts_undelivered` | The oldest staff alert has waited over 20 minutes. Staff are not being told about incidents. | `/staff/operations` shows why (no email service, the service refused, no active admin or support staff). Check `RESEND_API_KEY`, the sending domain, and the staff list. |
| `check_failed` | The health read itself failed. | Convex status and dashboard logs. |

The answer never carries a company, an id, a count or a secret. It is one indexed read per check and one for
the oldest waiting alert, sent with `Cache-Control: no-store`, so polling every minute is fine.

**It answers for the backend you asked.** `/health` is never forwarded. The old backend
(`terrific-avocet-835`) passes old links and webhooks on to production (`MOVED_TO`), but its `/health`
describes itself, so it cannot make production look healthy or unhealthy.

## How staff alerts are counted as delivered

An alert is marked sent only when the email service accepted it for at least one person. If the service
refuses (a revoked key, an unverified domain), is not set up, or no active admin or support staff member
exists, every alert stays waiting and is tried again every five minutes under the same key, so nobody who
did receive it gets it twice. `/staff/operations` shows "Alerts are not being delivered" with the reason,
and `/health` turns to `alerts_undelivered` after 20 minutes.

On a backend that is not production, alerts go only to `TEST_RECIPIENTS`; with no staff address on that
list they are dropped (recorded as such) rather than left to grow.

## Setting up an independent monitor (any uptime service)

1. Create an **HTTP(S) check** for `https://stoic-gazelle-731.convex.site/health`, method GET.
2. Interval: every 1 to 5 minutes. Timeout: 10 seconds.
3. Alert when the status is **not 200**, or on timeout. If the service can match the body, also require
   `"ok":true`. Wait for two failures in a row before alerting, to ride out a single slow answer.
4. Notify somewhere that does **not** depend on what is being watched: a phone call or SMS, a push
   notification, or an email address on a different mail provider. Not an address that is delivered through
   Selestial's own Resend account, and not only the same inbox the staff alerts go to.
5. Add a second check for `https://api.selestial.io/health` if you want to know about the custom domain.
6. Test it: point the monitor at a wrong path once (for example `/health-test`, which answers 404) and
   confirm the alert reaches a phone. Then put the real address back.
7. Write down in `00-decisions.md` which service, who is notified, and who covers nights and weekends.

## What it does not cover

- The website (Vercel). Add a separate check for `https://app.selestial.io`.
- Individual providers. Those are incidents inside Selestial, shown on `/staff/operations`.
- A check that runs and finishes but is wrong. The checks have tests; the heartbeat only proves they run.
