# Producing the setup guides

The six setup guides (`docs/tutorials/01-setup-guides.md`) are recorded from the real application, running
locally against a throwaway backend, with a fictional company. This page is everything needed to record, narrate,
assemble, check and publish one again. The general rules in `README.md` apply.

## The demo environment (local only)

Nothing here can reach a real deployment, inbox or phone:

- **Backend:** a local Convex backend with no account. Every script removes `CONVEX_DEPLOY_KEY` and refuses to run
  unless `.env.local` points at `http://127.0.0.1:<port>`.
- **Sign-in:** the Clerk **development** instance. `tutorials/demo/lib.mjs` checks `environment_type` before
  creating anyone. Demo people use `…+clerk_test@example.com`, which Clerk never emails (code `424242`).
- **Messages:** the backend runs with `MESSAGING_PROVIDER=mock` and `EMAIL_PROVIDER=mock`.
- **Plan:** a new company's plan normally comes from billing. `convex/tutorialDemo.ts` (git-ignored, never
  committed) sets it on the local backend only, and refuses unless `TUTORIAL_DEMO=local`.

```bash
env -u CONVEX_DEPLOY_KEY CONVEX_AGENT_MODE=anonymous npx convex dev --tail-logs disable
```

```bash
for kv in "CLERK_JWT_ISSUER_DOMAIN=https://first-opossum-325.clerk.accounts.dev" "MESSAGING_PROVIDER=mock" "EMAIL_PROVIDER=mock" "TUTORIAL_DEMO=local" "LINK_ORIGIN=http://localhost:3100" "APP_ORIGIN=http://localhost:3100" "SITE_ORIGIN=http://localhost:3100"; do env -u CONVEX_DEPLOY_KEY npx convex env set "${kv%%=*}" "${kv#*=}"; done
```

```bash
env -u CONVEX_DEPLOY_KEY npx convex env set ACTION_LINK_SECRET "$(openssl rand -hex 32)"
```

Also create `convex/tutorialDemo.ts` as described in its own header (an internal `setPlan` mutation guarded by
`TUTORIAL_DEMO`), and add to `.env.local` the development publishable key
(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), a `CLERK_SECRET_KEY` (in a cloud session the proxy supplies the real
development key; any `sk_test_…` placeholder works) and `NEXT_PUBLIC_SITE_ORIGIN=http://localhost:3100`. Then:

```bash
NODE_USE_ENV_PROXY=1 npx next dev -p 3100
```

`NODE_USE_ENV_PROXY=1` matters in a cloud session: without it, Node's `fetch` skips the proxy that supplies keys.

## A starting state per guide

Each guide starts from a fresh demo owner, so its first frame is exact:

| Guide | Prepare |
|---|---|
| setup-company | `node tutorials/demo/owner.mjs t1` (no company: the video creates it) |
| setup-services, setup-cleaners, setup-communication, setup-agents | `node tutorials/demo/owner.mjs tN && node tutorials/demo/seed.mjs company tN` |
| setup-clients | the above, then `node tutorials/demo/seed.mjs service t3` |

`seed.mjs company` leaves the company as guide 1 does (plan, setup basics, ZIP codes 78701/78702/78704/78745,
weekday booking hours). `seed.mjs service` publishes "Standard home cleaning" through the real screens.

## Record, narrate, assemble

```bash
NODE_USE_ENV_PROXY=1 node tutorials/scripts/capture.mjs setup-services --storage tutorials/.auth/t2.json
```

- Frames come from the browser's screencast at exactly 1920×1080 (a 1280×720 page at 1.5×; guide 3 uses
  1440×810). The cursor, highlight rings, callouts and "Sped up" tags are drawn in the page.
- `--scene <id>` records one scene; `--from <id>` records that scene and the rest. A scene that changes data
  (creating a company, importing) needs a fresh owner to record again.
- A failed step writes `clips/<scene>.failed.png`.
- `"kind": "card"` scenes are the branded title and closing frames, from `tutorials/scripts/card.html`.

```bash
NODE_USE_ENV_PROXY=1 node tutorials/scripts/narrate.mjs setup-services
```

- The voice, model, settings and pronunciations are in `tutorials/voice/voice.json`. `say` maps a written word
  to how the voice should read it (`"Selestial": "Celestial"`); captions keep the written spelling.
- Every line is cached by content in `tutorials/build/.narration-cache`. Only new or changed lines are sent;
  the run prints the characters it used. A voice sample first: `node tutorials/scripts/voice-sample.mjs "Selestial" "Celestial"`.

```bash
node tutorials/scripts/assemble.mjs setup-services
```

Writes `tutorial.mp4` (H.264/AAC, faststart), `captions.vtt` (from the voice's own timings, never overlapping),
`poster.jpg` (1280 wide), `transcript.txt` and `media.json` in `tutorials/build/<id>/v<version>/`. Scenes join with
0.3 s crossfades inside the silent lead and tail; `"speed"` plays a scene faster (always with a visible tag).

## Check, then publish

1. Watch it with captions, on a laptop and a phone, against the checklist in `README.md`.
2. Try it in the app before uploading: copy the build into `public/tutorial-media/<id>/v<version>/` (git-ignored),
   then as the local demo staff person (`node tutorials/demo/owner.mjs staff`, and `STAFF_BOOTSTRAP_EMAIL` set to
   its address on the local backend) call `tutorials:setMedia` with `/tutorial-media/…` paths and
   `tutorials:setState` `published`.
3. Copy the narration into the guide's `transcript` in `convex/lib/tutorials/setup.ts` and set
   `interfaceVerifiedOn` to the recording date.
4. Upload: `BLOB_READ_WRITE_TOKEN=… node tutorials/scripts/publish.mjs <id>`. It prints the media entry.
5. At /staff/tutorials: Replace media version with that entry, then Published.
