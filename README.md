# usai · intellistudy

A **collaborative AI-architecture lab** in a single Cloudflare Worker. The interface is a
chat that *operates* the lab: it ingests links and research into saved **studies**, designs
**benchmarks** (model × harness-pattern × effort grids), **runs them for real** against live
model APIs, and reports **measured** results — token cost, dollar cost, latency, pass rate,
cost-of-pass, convergence, and leverage — so you can select and deploy architectures on
evidence, not vibes.

Everything the lab produces is a durable, shared artifact in KV: studies, benchmarks + run
history, and the chat threads themselves.

```
src/
  worker.js   # routes: /api/chat (agent stream), studies, benchmarks, runs, queue; cron drains the queue
  agent.js    # the chat agent — Claude (claude-opus-4-8) with lab tools + web_search/web_fetch
  lab.js      # the runner: patterns, checkers, pricing, metering, metrics
  store.js    # KV layer: studies · benchmarks · threads · run queue (+ v1 import)
public/
  index.html  # the chat workbench UI (single file, no build)
legacy/       # the retired v1 dashboard (thin shell + views), kept for reference; not served
```

Method details — patterns, checkers, exact metric definitions, budgets — are in
**[METHODS.md](./METHODS.md)**.

## What a session looks like

- *paste a URL* → fetched, distilled, saved to a study with the source.
- *"research X"* → web-searched (primary sources), saved as a cited note.
- *"compare sonnet vs haiku with a critique loop on these 4 tasks"* → the agent proposes a
  spec + cost estimate → you approve → it creates and **runs** it → you get a measured
  metrics table per variant and a recommendation, with sample-size caveats.
- *"what should I deploy for our ticket triage?"* → it reads your saved runs and studies and
  recommends an architecture grounded in the numbers.

Big grids don't run synchronously — the agent queues them and the nightly cron (15-minute
budget) executes and files the run.

## Run locally

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars     # required for chat + runs
npm run dev                                          # wrangler dev on :8787
```

Or Docker (`docker compose up --build`, pass `ANTHROPIC_API_KEY=` through). Without a key the
UI and library render; chat and runs return a clear setup error.

## Deploy

```bash
npx wrangler kv namespace create USAI_KV     # once; paste the id into wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY    # required
npx wrangler secret put ACCESS_TOKEN         # recommended — gates /api/* behind a shared key
npm run deploy
```

`ACCESS_TOKEN` matters: chat and benchmark runs spend **your** Anthropic tokens, and a
workers.dev URL is public. With the secret set, the UI prompts once for the key and sends it
as `x-usai-key`.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | `{ ok, hasKey, kv, gated, queue }` |
| `/api/state` | GET | sidebar indexes (threads/studies/benchmarks); folds v1 data into a study once |
| `/api/chat` | POST | `{ threadId?, message }` → NDJSON agent stream (deltas, tool events, progress, artifacts) |
| `/api/thread(s)` | GET/POST | list / read / create saved chat threads |
| `/api/studies`, `/api/study/:id` | GET | the research corpus |
| `/api/benchmarks`, `/api/bench/:id` | GET | specs + measured run history |
| `/api/bench/run` | POST | `{ id }` → NDJSON: progress heartbeats, then the measured run |
| `/api/bench/queue` | POST | `{ id }` → queued for the nightly cron |

## Provenance

v1 of this repo was a thin-shell dashboard whose "benchmark" was web-search-derived 0–5
scores — editorial, not empirical. v2 replaces it with measured experiment runs; the v1
research corpus is auto-imported into a study on first request, and the old dashboard lives
in `legacy/`.
