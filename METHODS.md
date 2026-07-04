# intellistudy — methods

What the lab measures, exactly how, and what the numbers mean. The spec-of-record
is the code: `src/lab.js` (runner, metrics, pricing), `src/pods.js` (open-weight
provisioning), `src/tools.js` (the tool surface), `src/agent.js` (the driver).
Governance lives in [DIRECTIVE.md](./DIRECTIVE.md) — R1–R5 bind everything here.

## Providers

- **Anthropic API** (`provider:"anthropic"`): metered from billed usage × the
  pricing table. Per-model parameter shaping is honest to each surface (haiku: no
  effort/thinking; fable-5: thinking always on; opus/sonnet: adaptive).
- **Open weights** (`provider:"vllm"` + `pod_id`): served by vLLM on RunPod GPUs
  (`provision_pod` → `pod_status` until `ready` → benchmark → `terminate_pod`).
  Cost is **pod-hour amortized per call** (rate × call wall-clock) — a serial
  upper bound when cells run in parallel, since the pod bills by the hour
  regardless. TTL reaping (hourly) and the $50 provisioning cap are enforced in
  code. `temperature: 0` and the served model id are logged.

## Uncertainty (R4 quadruple)

Every pass-rate carries a **95% Wilson interval** and its n. Runner enforcement
of budget: each run has a `budgetCapUsd` (default $10, max $50) and aborts
mid-run when cumulative spend crosses it (`status: "partial-budget"`).

## Ruler identity (R2/R3)

Every run stamps `harness: {version, templateHash}`; every call records the
**served** model string. Benchmarks freeze on first run; `amend_benchmark`
creates version N+1 with a parent link.

## The object model

- **Study** — a research document: notes with sources. Grown by chat: paste a link
  (ingested via `web_fetch`), ask for research (`web_search`), or tell it something
  worth keeping. Durable, shared, cited.
- **Benchmark** — an experiment spec plus its run history. A spec is a grid:

  ```
  tasks    (1–8)   prompt + an objective check
  variants (1–6)   model × pattern × effort — variants[0] is the BASELINE
  trials   (1–3)   repeats per cell (enables convergence measurement)
  ```

- **Run** — one execution of the grid against live APIs, every call metered.
- **Thread** — a saved chat conversation. The chat is the instrument's control
  surface; threads make the reasoning shareable.

## Harness patterns (what "design pattern" means here)

Implemented in `src/lab.js` so they're identical, comparable code:

| pattern | calls | what it tests |
|---|---|---|
| `single` | 1 | the raw model |
| `plan` | 2 | plan-then-execute decomposition |
| `critique` | 2 | draft → self-critique → final |
| `bestofN` | n+1 | n parallel drafts + a cheap picker (test-time scaling) |

Pattern overhead — extra calls, the picker — is **charged to the variant**. That's
deliberate: leverage is only meaningful if the harness pays for itself.

## Checks

`contains` (case-insensitive substring) · `regex` · `number` (any number in the
answer within tolerance) · `judge` (a `claude-haiku-4-5` PASS/FAIL against your
rubric — its cost is tracked separately as `evalCost`, *not* charged to variants).

Prefer objective checks. A judge is a measurement instrument with its own error bar.

## Metrics (all measured, never estimated)

| metric | definition |
|---|---|
| **pass rate** | passes / cells for the variant |
| **token cost** | billed input/output tokens summed over the variant's calls (incl. cache reads/writes) |
| **dollar cost** | tokens × the pricing table in `src/lab.js` |
| **latency** | mean wall-clock per cell |
| **cost-of-pass** | variant $ / passes (∞ if zero passes) — the founding metric |
| **convergence** | trials > 1: fraction of tasks where all trials agree on the verdict (`trial-agreement`). critique pattern at 1 trial: fraction of cells where the revision did **not** materially change the draft (`settled-rate`). otherwise n/a |
| **leverage** | (pass-rate − baseline pass-rate) / ($ − baseline $): extra pass-rate per extra dollar vs `variants[0]`. `dominates` = better and cheaper. `dominated` = worse and not more expensive |

## Honest-numbers rules

1. The chat may only report metrics returned by the runner or facts from cited
   sources — it is instructed to never invent standings.
2. Small grids are smoke signals, not proof. 2 tasks × 1 trial tells you which
   follow-up to run, not what to deploy. The assistant is told to say so.
3. Per-model parameter shaping is honest to each API surface: haiku runs without
   effort/thinking (unsupported); fable-5 always thinks (never sent the param);
   opus/sonnet run adaptive thinking unless a variant turns it off.
4. Model pricing lives in one table (`PRICING` in `src/lab.js`). Update it when
   prices move; every historical run stores its own computed dollars.

## Execution budgets

- **Synchronous runs** (chat `run_benchmark` / panel "Run now"): capped at ~30
  model calls; progress lines stream continuously (keeps the connection alive
  past Cloudflare's ~100s edge timeout); each API call is bounded (80s, 1 retry).
- **Queued runs** (`queue_benchmark` / panel "Queue"): the nightly cron drains the
  queue with a ~15-minute budget and a ~60-call cap.

## Collaboration & access

Studies, benchmarks, runs, and threads live in KV on the deployment — everyone
who opens the URL shares the same lab. Because chat and runs spend your Anthropic
tokens, set the optional `ACCESS_TOKEN` secret to gate `/api/*` behind a shared
key (the UI prompts once and remembers it).
