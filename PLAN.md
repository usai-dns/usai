# Plan: intellistudy — local Docker + Cloudflare Workers

## Context

`/Users/usai/Projects/intelligence` holds a 4-file prototype of **intellistudy**: a "thin shell"
research dashboard for AI model/harness experiments. The design intent (stated in `hub.html`'s
header) is deliberate and worth preserving:

- The shell (`hub.html`) does only two things: render a **canonical data layer**
  (experiments · results · discoveries · resources) from `data/state.json`, and load
  **agent-generated view-components** from `views/*.js` listed in `views/manifest.json`.
- You never extend the shell. To add a visualization, an agent *generates* a `views/name.js`
  file calling `HUB.registerView({id,title,group,render(data,el)})`.

**Two problems with the current state:**
1. The files are mis-located. The shell fetches `data/state.json` and `views/manifest.json`,
   but the files sit at repo root (`state.json`, `manifest.json`, `convergence.js`). So it only
   ever runs in the embedded-fallback mode, never live.
2. `views/manifest.json` references `results-table.js`, which **does not exist** as a file — it
   only lives inline as a fallback view inside `hub.html` (lines 139–142).

**Goal:** wire it up correctly, make it runnable locally in Docker without any Cloudflare login,
and deployable to Cloudflare Workers from the *same* codebase — then push to a public repo `usai`
under the `usai-dns` GitHub account.

## Decisions (confirmed with user)

- **Data model:** static + redeploy. No KV / write API. Shell serves `data/` and `views/` as
  static assets; to update, the agent regenerates files and you redeploy.
- **Repo:** `usai`, public, under `usai-dns`.

## Architecture

One codebase, identical local and cloud, via **Cloudflare Workers Static Assets** (assets-only
Worker — no Worker script needed):

```
GET /                  -> public/index.html   (the thin shell)
GET /data/state.json   -> served as static asset
GET /views/manifest.json
GET /views/*.js
```

- **Local (Docker, no permissions/login):** run `wrangler dev` inside the container. It uses
  workerd/Miniflare fully offline — no Cloudflare account required. This gives true parity with
  production (same runtime serving the same assets) rather than an unrelated static server.
- **Cloud:** `wrangler deploy` ships the exact same `public/` dir to `usai.<account>.workers.dev`.

Container base is **`node:22-slim`** (Debian/glibc), not alpine — workerd ships glibc binaries and
misbehaves on alpine's musl.

## Files to create

Target repo layout:

```
usai/
  public/
    index.html            # the shell (relocated from hub.html, served at /)
    data/state.json       # relocated from ./state.json
    views/manifest.json   # relocated from ./manifest.json
    views/convergence.js  # relocated from ./convergence.js
    views/results-table.js  # NEW — extracted from the inline fallback in hub.html
  wrangler.toml
  package.json
  Dockerfile
  docker-compose.yml
  .dockerignore
  .gitignore
  README.md
```

Detail per file:

1. **`public/index.html`** — content is the current `hub.html` essentially verbatim (its
   `fetch('data/state.json')` / `fetch('views/manifest.json')` already resolve correctly from `/`).
   Only the self-referential header comment is updated (file is now `index.html`, served at root).
2. **`public/data/state.json`** — current `state.json` verbatim.
3. **`public/views/manifest.json`** — current `manifest.json` verbatim (`convergence.js`,
   `results-table.js`).
4. **`public/views/convergence.js`** — current `convergence.js` verbatim.
5. **`public/views/results-table.js`** — NEW. Promote the inline `results-table` fallback view
   (`hub.html:139–142`) into a real `HUB.registerView({...})` module so live mode renders both
   views (today live mode silently drops it because the file is missing).
6. **`wrangler.toml`**:
   ```toml
   name = "usai"
   compatibility_date = "2025-06-19"
   assets = { directory = "./public" }
   ```
   Assets-only Worker — no `main`. Both `wrangler dev` and `wrangler deploy` work from this.
7. **`package.json`** — `wrangler` as devDependency; scripts: `dev` (`wrangler dev --ip 0.0.0.0
   --port 8787`), `deploy` (`wrangler deploy`).
8. **`Dockerfile`** — `node:22-slim`, `npm ci`, copy repo, `EXPOSE 8787`, default CMD runs
   `npm run dev`.
9. **`docker-compose.yml`** — builds the image, maps `8787:8787`, bind-mounts `./public` so edits
   to data/views hot-reload without a rebuild.
10. **`.dockerignore`** — `node_modules`, `.wrangler`, `.git`.
11. **`.gitignore`** — `node_modules/`, `.wrangler/`, `.dev.vars`, `dist/`.
12. **`README.md`** — three sections: (a) run locally (`docker compose up`, open
    `localhost:8787`); (b) deploy to Cloudflare (`npx wrangler login` once, then
    `npm run deploy`); (c) the contract for adding a view (write `public/views/name.js` calling
    `HUB.registerView`, add it to `public/views/manifest.json`, never edit `index.html`).

The four original root-level prototype files are superseded by their correctly-located copies
under `public/`; the repo is fresh (not currently a git repo), so there is no history to preserve.

## Execution order

1. Create the `public/` tree and all config files above.
2. Local verify with Docker (see Verification).
3. `git init`, commit. Create public repo `usai` under `usai-dns` via `gh repo create`, push.
4. (Optional, only if user wants it live now) `wrangler login` + `npm run deploy` — requires
   interactive Cloudflare auth, so I'll leave this for the user to trigger and document it instead.

## Verification

**Local (primary, no login needed):**
- `docker compose up --build`, open `http://localhost:8787`.
- Expect: top-right status reads `data: live · views: 2` (NOT "embedded" / "inline examples").
- Expect: left sidebar lists 3 experiments, 3 results, 2 discoveries, the resource chips.
- Expect: right column renders both generated views — the animated "Convergence vs thrash"
  canvas and the "Results · cost-of-pass" table with 3 rows.
- Sanity-check the asset routes directly: `curl -s localhost:8787/data/state.json` and
  `curl -s localhost:8787/views/manifest.json` return the JSON.
- Edit `public/data/state.json` (e.g. add a result), reload — change appears without rebuild
  (bind mount), confirming the "regenerate files" update flow.

**Cloud (smoke, when user deploys):** `npm run deploy` prints a `*.workers.dev` URL; the same
status line and views render there.

**GitHub:** `gh repo view usai-dns/usai` shows the public repo with the pushed tree.

---

# v1 — from static dashboard to study worker

The v0 above is a *static* thin shell (curated data + generated views, assets-only Worker). v1
turns it into an **active AI-capability study worker** while preserving the shell contract.

## What changed and why

The brief: a worker that studies AI advancements on a schedule, benchmarks Claude Code (cloud +
CLI), Claude-with-tools, open source, and research, and offers a chat interface to parse findings
and deploy a framework against problems. That needs **compute + persistence + autonomy** — so v1
deliberately supersedes the v0 "static + redeploy, no KV" decision:

- **Assets-only Worker → Worker script** (`src/worker.js`) with `fetch` (dashboard + API + merged
  state) and `scheduled` (cron-driven autonomous study). `run_worker_first` routes `/api/*` and
  `/data/state.json` to the script; everything else is still served straight from `public/`.
- **Static `state.json` → merged `/data/state.json`.** The static seed moved to
  `public/data/seed.json`; the worker merges it with the study framework (from `src/studies.js`)
  and live KV data. **`index.html` is untouched** — it still just reads `/data/state.json`, which
  now grows as the worker studies.
- **Added KV** (`USAI_KV`) for findings + live benchmark scores; **added a cron** (`0 13 * * *`).
- **Added Claude** (`@anthropic-ai/sdk`, `claude-opus-4-8`, adaptive thinking, `web_search` /
  `web_fetch` server tools) for the study pass and streaming chat. Degrades gracefully with no key.
- **New UI as generated views only** — `chat`, `benchmark`, `findings`, `study-plan` — honoring
  the "never extend the shell" contract. Dynamic views re-fetch on a `usai:refresh` event.

## Framework

Single source of truth in `src/studies.js`: 5 study tracks, a 5-subject × 7-axis commercial
benchmark with a 0–5 rubric and seed scores, and the weekly schedule. Written up in `STUDIES.md`.

## Verified locally (`wrangler dev`)

- Boots; SDK bundles; `env.USAI_KV` (local) + `env.ASSETS` bound.
- `/data/state.json` merges seed + studies + benchmark + findings + meta; assets + views serve.
- No-key paths degrade cleanly: chat returns setup text (`x-usai-status: no-key`), study returns
  400, scheduled logs a skip.
- Live path reaches the Anthropic API (egress open; a bogus key yields a clean **502 api-error**,
  not a 500) — confirming the wiring works end-to-end with a real key.

## Deploy (unchanged flow, two extra one-time steps)

`wrangler login` → `wrangler kv namespace create USAI_KV` (paste id) →
`wrangler secret put ANTHROPIC_API_KEY` → `npm run deploy`. The cron then runs daily.

---

# v2 — from editorial dashboard to measuring lab

Operator verdict on v1: "a meaningless dashboard." Correct diagnosis: v1's benchmark
scores were produced by web research — Claude's *opinion* on a 0–5 scale — so nothing
in the product measured anything. The numbers couldn't justify a deploy decision.

v2 inverts the architecture around the operator's actual loop — *take information /
research → design experiments → run them → select an architecture → deploy*:

- **Chat-first.** The UI is a chat workbench (`public/index.html`); the assistant holds
  lab tools (`save_study_note`, `create_benchmark`, `run_benchmark`, `queue_benchmark`,
  `get_*`) plus `web_search`/`web_fetch`. Conversations produce durable artifacts.
- **Benchmarks are real runs.** `src/lab.js` executes tasks × variants (model × pattern
  × effort) × trials against live APIs and meters every call: tokens, $ (pricing table),
  latency, pass rate (objective checkers or a haiku judge), cost-of-pass, convergence
  (trial agreement / critique settled-rate), and leverage (Δpass-rate per Δ$ vs the
  baseline variant). Harness patterns implemented: single, plan, critique, best-of-N.
- **Collaborative persistence.** Studies, benchmarks + runs, and threads live in KV,
  shared by everyone on the deployment; optional ACCESS_TOKEN secret gates /api/*.
- **Cron = queue drain.** The daily editorial study is gone; scheduled invocations now
  execute queued (large) benchmark runs with the 15-minute budget.
- **Continuity.** v1 findings + the Kaggle leaderboard pull auto-import into a study on
  first request (`store.migrateV1`); the v1 thin-shell dashboard is preserved unserved
  in `legacy/`.

Verified end-to-end before deploy: one chat message designed, created, and ran a
2-task × 2-variant benchmark in 22s (6 metered API calls), persisted the run, and the
assistant's analysis used only the measured numbers — including the honest "this sample
is a smoke signal" caveat and a proposed follow-up experiment.
