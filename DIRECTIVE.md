# INTELLISTUDY DIRECTIVE v1.0 (+ v1.1-draft addenda)

**Status:** v1.0 COMMITTED (July 3, 2026) · addenda DRAFT pending Dennis's sign-off
**Owner:** Dennis Lee, Forward Flow LLC
**Consumed by:** the intellistudy chat driver (`src/agent.js` embeds the operative rules as its system prompt) and any LLM connected via MCP (`/mcp`)
**Authority chain:** this directive > experiment definitions > driver judgment.

The full v1.0 text is the operator's document of record; this file mirrors its
operative content for the repo and adds the implementation mapping. Where the
driver enforces a rule in code, the enforcement point is named.

---

## Standing rules (v1.0 §1) — and where they're enforced

- **R1 — Hold the scaffold constant when the model is the variable.** Harness patterns are fixed code (`src/lab.js`); every run stamps `harness.version` + `templateHash`. Cross-model specs reuse identical patterns per variant.
- **R2 — Evals are frozen and versioned.** A benchmark freezes on its first run (`store.addRun` sets `frozen`); there is no update path. Changes go through `amend_benchmark` → version N+1 with a `parentId` link; old versions stay runnable forever. Enforced at the API layer, not by convention.
- **R3 — Measured performance only.** Rankings come from runs. Every call records the **served** model string (`response.model` / vLLM `model`), not just the requested alias — API models change under stable names.
- **R4 — Always report the triple** — implemented as the **quadruple**: result quality **with 95% Wilson CI and n**, dollar+token cost, wall-clock, uncertainty. (v1.1-draft amendment #1, accepted in spirit: a rate without an interval is half a number.)
- **R5 — Private benchmarks stay private.** Driver conduct rule: authored gold items never go to web tools or crawlable stores; borrower-PII / client items only against endpoints with no-training guarantees or on our own pods. NOTE (v1.1-draft #3): running Class B items against a provider API sends them to that provider — e.g. `claude-fable-5` requires 30-day retention, so PII gold sets are open-weight/on-metal only under standard terms.

## Benchmark policy (v1.0 §2)

Class A replicated public anchors (GPQA-Diamond, LiveCodeBench, IFEval, Tau²) run on the execution plane (lm-evaluation-harness against vLLM/API endpoints) — **not yet automated on this deployment**; the calibration map reports `insufficient-data` honestly until anchor runs exist. Class B authored benchmarks run on the built-in runner with mechanical checks (`contains|regex|number`) or a frozen judge (`claude-haiku-4-5`, identity + rubric part of the eval version).

**Calibration map:** `get_calibration_map(problem_class)` returns measured vectors; per v1.1-draft #5 it refuses to fit predictions below ~10 models (rank ordering only) and is keyed by harness version.

**Drift (v1.1-draft #1):** drift = CI non-overlap on like-for-like config (same prompt-template hash, same params), not a raw 3-point delta; two consecutive events escalate to Dennis.

## Providers & collection (v1.0 §3)

Open-weight roster + GPU tiers live in `src/pods.js` (`ROSTER`, `GPU_TIERS`) — suggestions, re-verified by the weekly scan (Mondays 13:00 UTC, report-only, logged to the "Weekly digests" study; candidates are never run without approval). Frontier APIs (Anthropic priced in `src/lab.js PRICING`) serve as ceiling reference and drift monitoring.

## Replication path (v1.0 §4)

vLLM (OpenAI-compatible) on RunPod is the standard open-weight server: `provision_pod` → readiness (`pod_status`) → benchmark (variants with `provider:"vllm"`) → `terminate_pod`. Safety rails enforced in code: TTL (default 2h, max 8h) with an hourly reaper; provisioning refuses rate×TTL over the **$50 standing cap**; every run carries a `budgetCapUsd` (default $10) and aborts mid-run when exceeded. Pod-hour cost is amortized per call (serial upper bound — documented in METHODS.md). Class A anchor automation (lm-evaluation-harness on the pod) is the next execution-plane build.

## Problem intake (v1.0 §5)

`submit_problem` captures the schema; **P-001 (post-call transcript parsing → FF-EXTRACT v1.0)** is seeded, `gold_set_status: blocked on the 50 transcripts`. Deployment remains outside intellistudy's write access: the lab issues recommendation reports only.

## MCP interface (v1.0 §6)

`/mcp` (streamable HTTP, token-gated by `ACCESS_TOKEN` via `x-usai-key`). The surface is the same registry the chat uses (`src/tools.js`), plus directive aliases `define_experiment` → `create_benchmark`, `run_experiment` → `run_benchmark`. Money-spending tools restate projected cost in their descriptions and enforce caps in code.

```
claude mcp add --transport http intellistudy https://<host>/mcp --header "x-usai-key: <ACCESS_TOKEN>"
```

## Driver constraints (v1.0 §7)

Embedded verbatim-in-spirit in `src/agent.js` (`systemPrompt`): claims trace to run_ids/registry/citations; labeled recommendation is permitted, unlabeled speculation in results is not (v1.1-draft #4); driver model identity is logged per thread; on user-vs-directive conflict the driver states the conflict and holds.

## v1.1-DRAFT amendments awaiting sign-off

1. Statistical drift thresholds; R4 → quadruple with CI + n. *(implemented)*
2. Holdout hygiene: intervals mandatory; grow gold sets ≥100 items before decisive holdout verdicts; rotate holdouts on major decisions. *(conduct rule)*
3. Class B items only to no-training endpoints; PII → open-weight/on-metal. *(conduct rule)*
4. §7 rewording: labeled recommendation allowed. *(implemented in driver prompt)*
5. Calibration map: rank-only below ~10 models; harness-keyed. *(implemented)*
6. Freeze the whole ruler: judge and any user-simulator identities are part of eval versions; log served-model strings everywhere. *(implemented for judge + served models)*

## Changelog

- **v1.0 (2026-07-03):** operator's initial directive (see thread of record).
- **v1.1-draft (2026-07-04):** driver-review amendments 1–6 above; implementation mapping added. Awaiting Dennis's sign-off to become v1.1.
