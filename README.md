# usai · intellistudy

An AI-capability **study worker** with a thin-shell dashboard. It studies how to deploy AI
effectively — Claude Code (cloud + CLI), Claude with tools/systems, open source, and research —
on a **schedule**, scores a **commercial benchmark**, and gives you a **chat interface** to parse
the findings and steer the work.

Two layers:

1. **The worker** (`src/`, a Cloudflare Worker) runs autonomous web research on a cron, files
   sourced findings, updates the benchmark, and answers chat — all powered by Claude
   (`claude-opus-4-8`) with the `web_search` / `web_fetch` server tools.
2. **The thin shell** (`public/index.html`) renders a **canonical data layer** and loads
   **agent-generated views** (`public/views/*.js`). The shell is never edited — you add a way to
   *see* something by generating a view, and the worker grows the data underneath it.

```
src/
  worker.js     # fetch (dashboard + API + merged state) and scheduled (autonomous study)
  studies.js    # THE FRAMEWORK: study tracks, benchmark rubric, schedule (single source of truth)
  anthropic.js  # Claude integration (study pass + streaming chat)
public/
  index.html            # the thin shell (served at /) — unchanged
  data/seed.json        # static canonical seed (experiments · results · discoveries · resources)
  views/manifest.json   # which views to load
  views/{chat,benchmark,findings,study-plan,convergence,results-table}.js
wrangler.toml           # Worker + Static Assets + KV + cron
```

The full study plan and benchmark methodology are written up in **[STUDIES.md](./STUDIES.md)**.

## What it does

- **Studies on a schedule.** A daily cron picks the day's subject (Mon→cloud, Tue→CLI,
  Wed→tools, Thu→open-source, Fri→research, Sat→synthesis, Sun→idle), runs a Claude `web_search`
  pass, and files a sourced finding plus updated benchmark scores into KV.
- **A commercial benchmark.** Five subjects — **Claude Code Cloud, Claude CLI, Claude + Tools,
  Open Source, Research** — scored on seven axes (autonomy, tool breadth, convergence,
  cost-of-pass, context/scale, deployability, ecosystem). Ships with seed estimates the worker
  refines with sources.
- **A chat interface.** Ask questions over the accumulated corpus; paste a link and have it
  studied and filed. Streaming, corpus-aware, search-enabled.
- **Study a link on demand.** “Study & file” in the chat view, or `POST /api/study/run`.

## Run locally (Docker — no Cloudflare login)

```bash
docker compose up --build                       # dashboard + framework, no key needed
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build   # + live chat & study
```

Open <http://localhost:8787>. The container runs `wrangler dev` (Cloudflare's local `workerd`
runtime, fully offline — same runtime production uses). `public/` and `src/` are bind-mounted, so
editing data, views, or worker code and reloading takes effect without a rebuild.

Status line should read `data: live · views: 6`. Without a key, the dashboard, study plan, and
benchmark render fully; chat and study return clear setup instructions.

### Without Docker

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars   # optional; enables chat + study
npm run dev                                        # wrangler dev on :8787
npm run dev:scheduled                              # also lets you fire the cron locally
```

Fire a scheduled study run locally (with `dev:scheduled`):

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+13+*+*+*"
```

## API

| Route | Method | Purpose |
|---|---|---|
| `/data/state.json` | GET | Merged canonical data (seed + live findings/scores) — what the shell reads |
| `/api/health` | GET | `{ ok, hasKey, model, kv, lastRuns, todaysSubject }` |
| `/api/chat` | POST | `{ messages, studyUrl? }` → streamed answer over the corpus |
| `/api/study/run` | POST | `{ subject?, url?, question? }` → runs one study pass, **streams** heartbeats then the finding JSON |

## Operational notes

Study runs do live web research, so latency is real and variable (~40–160s):

- **On-demand (`/api/study/run`)** runs lean (low effort, ≤2 searches) and **streams** the
  response — an immediate heartbeat keeps the connection alive past Cloudflare's ~100s edge
  timeout, then the finding JSON arrives as the final line. The Anthropic client is bounded (80s
  timeout, 1 retry) so a slow turn fails cleanly in ~160s instead of a multi-minute retry storm.
- **Scheduled (cron)** runs thorough (high effort, more searches) — a scheduled invocation has a
  15-minute budget and isn't subject to the HTTP edge timeout, so it's the reliable producer.
- Each run costs Claude tokens (your `ANTHROPIC_API_KEY`). The daily cron fills the benchmark for
  free over a week; "Run now" / `/api/study/run` is for when you want a subject studied immediately.

## Deploy to Cloudflare

```bash
npx wrangler login                               # one-time, interactive
npx wrangler kv namespace create USAI_KV         # paste the id into wrangler.toml [[kv_namespaces]]
npx wrangler secret put ANTHROPIC_API_KEY        # the Claude key (never commit it)
npm run deploy                                   # ships src/ + ./public to usai.<account>.workers.dev
```

The cron (`[triggers].crons` in `wrangler.toml`, default `0 13 * * *`) then runs the daily study
automatically. Change the cadence there and the day→subject map in `src/studies.js` (`SCHEDULE`).

## Adding a view (the contract)

To add a visualization, **generate a new view file** — do not edit `index.html`:

1. Write `public/views/<name>.js` that calls:
   ```js
   HUB.registerView({ id, title, group, render(data, el) { /* read data, draw into el */ } });
   ```
   `data` is the parsed `/data/state.json` (now including `studies`, `benchmark`, `findings`);
   `el` is the mount node. For live updates after a study run, re-fetch `/data/state.json` on the
   `window` `usai:refresh` event (see `benchmark.js` / `findings.js`).
2. Add `"<name>.js"` to `public/views/manifest.json`.
3. Reload.

`benchmark.js`, `findings.js`, `study-plan.js`, and `chat.js` are the reference examples.

## Configuration

- **`ANTHROPIC_API_KEY`** — secret. Enables chat + autonomous study. `.dev.vars` locally;
  `wrangler secret put` in the cloud. The app runs without it (dashboard-only).
- **`USAI_KV`** — KV namespace for findings + live scores. Simulated locally by `wrangler dev`;
  needs a real id for deploy.
- **Model / effort** — `claude-opus-4-8`, adaptive thinking; study runs at `high` effort, chat at
  `medium`. Set in `src/anthropic.js`.
