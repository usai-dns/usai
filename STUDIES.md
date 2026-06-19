# intellistudy — v1 study plan & commercial benchmark

The purpose of this worker: **study AI advancements, abilities, and frameworks on a schedule, so
you can deploy AI more effectively to self-manage work or engineer solutions** — and turn that
study into a regimented benchmark you can act on.

This document is the human-readable spec. The machine-readable source of truth is
`src/studies.js`; the worker reads it, runs the research, and writes results into the dashboard.

---

## 1. The studies (tracks)

Five tracks, exactly mirroring the surfaces you asked to compare. Each has a goal, a reason it
matters for deployment, seed sources, and anchor questions the worker tries to answer every run.

| # | Track | Studies | Why it matters |
|---|---|---|---|
| 1 | **Claude Code — Cloud** | Claude Code on the web, remote sandboxes, GitHub Actions: autonomy, scheduling, parallel sessions, isolation, deploy story | The surface you're on now — the path to fleets of self-managing agents working async on your stack |
| 2 | **Claude CLI** | The local Claude Code CLI: hooks, slash commands, subagents, MCP, headless/SDK mode, effort/thinking controls | Highest-leverage way to put Claude on your machine and in your pipelines with full local context |
| 3 | **Claude + Tools & Systems** | Claude driving MCP, tool use, the Agent SDK, computer use, Managed Agents | Solving problems in your stack means Claude must reliably operate real systems, not just emit text |
| 4 | **Open Source** | Open-weight models + open agent frameworks (OpenHands/Aider-style), capability, cost, self-hostability | Sets the cost floor and the self-host fallback — the economic benchmark for everything you deploy |
| 5 | **Research & Evals** | Frontier papers, new benchmarks (SWE-bench & successors), eval design, inference-time techniques | Leading indicator of what your stack can do in 3–6 months and how to measure it honestly |

Anchor questions per track live in `src/studies.js` (`TRACKS[].questions`) and render in the
**Study plan** view.

---

## 2. The regimen (schedule)

One subject studied per weekday (UTC); Saturday synthesizes the week; Sunday idles.

| Day | Subject |
|---|---|
| Mon | Claude Code — Cloud |
| Tue | Claude CLI |
| Wed | Claude + Tools |
| Thu | Open Source |
| Fri | Research |
| Sat | **Synthesis** — cross-cutting "what changed this week and what to do about it" |
| Sun | idle |

Each run: a Claude `web_search` pass (primary sources preferred) → a sourced **finding** (headline,
≤120-word synthesis, 3–6 cited points) appended to the log → updated **benchmark scores** for that
subject. Cadence is `0 13 * * *` (daily 13:00 UTC); change it in `wrangler.toml` (`[triggers].crons`)
and the day→subject map in `src/studies.js` (`SCHEDULE`).

You can also run any subject on demand — including studying a specific link — from the **Chat**
view ("Study & file") or `POST /api/study/run`.

---

## 3. The commercial benchmark

A regimented scorecard: **5 subjects × 7 axes**, each scored **0–5**. This is the "benchmark to
deploy a framework against" — it tells you, per surface, where it's strong enough to trust with
autonomous work and where it still needs a human.

**Subjects:** Claude Code Cloud · Claude CLI · Claude + Tools · Open Source · Research.

**Axes (the rubric):**

| Axis | What it measures |
|---|---|
| **Autonomy** | How much it does unattended end-to-end (multi-step, scheduled, self-correcting) |
| **Tool breadth** | Range of tools/systems it can drive (files, shells, APIs, MCP, browsers) |
| **Convergence** | Reliability of reaching a correct end state vs thrashing |
| **Cost-of-pass** | Economic efficiency per successful task (higher = cheaper success) |
| **Context / scale** | Context window and repo-/project-scale handling |
| **Deployability** | Ease of putting into production in your stack (higher = lower friction) |
| **Ecosystem** | Pace of improvement, tooling, docs, community/research momentum |

The vocabulary deliberately extends the project's existing terms (`cost-of-pass`,
`convergence-vs-thrash`) so the benchmark is continuous with the experiment data already in
`seed.json`.

**Scale:** `0 absent · 1 nascent · 2 usable · 3 solid · 4 strong · 5 best-in-class.`

**Seed vs studied.** v1 ships with defensible **seed** estimates (mid-2026) so the scoreboard is
useful immediately. They render dimmed. Each scheduled run overwrites the studied subject's axes
with **sourced** scores (rendered bright, click-through to the source). So the benchmark starts
opinionated and becomes evidence-backed as the worker runs.

---

## 4. How study turns into deployment

The loop you asked for — parse information → regimented benchmark → deploy a framework to solve
problems or build products:

1. **Study** runs on the schedule (or on demand) and files sourced findings.
2. **Benchmark** updates, so at a glance you see which surface is ready for which kind of work.
3. **Chat** lets you interrogate the corpus: "Given the benchmark, what should I put on autonomous
   cloud agents vs keep in the CLI with a human?" — answered with current sources, leading with the
   recommendation.
4. **Act**: the benchmark + findings become the spec for wiring a surface into your stack (e.g.
   "Claude Code Cloud scores 5/4/4 on autonomy/tools/convergence → route the overnight refactor
   queue to scheduled cloud sessions; keep prod migrations in the CLI with review").

---

## 5. Extending it

- **Add a track:** append to `TRACKS` in `src/studies.js` and add a row to `SCHEDULE`.
- **Add a benchmark axis or subject:** append to `AXES` / `SUBJECTS` in `src/studies.js`.
- **Add a visualization:** generate `public/views/<name>.js` and list it in the manifest — never
  edit the shell (see README → "Adding a view").
- **Change cadence:** `wrangler.toml` `[triggers].crons`.

Everything else — running the research, persisting findings, scoring, serving the dashboard —
follows automatically.
