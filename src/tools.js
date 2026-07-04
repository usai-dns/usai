// tools.js — the lab's single tool surface, consumed by BOTH the chat agent
// (agent.js) and the MCP server (mcp.js). One registry, one executor, so a
// Claude Code session driving over MCP and the built-in chat have identical
// capabilities (directive §6: the MCP surface is also part of the test surface).

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import * as pods from "./pods.js";
import { runBenchmark, validateSpec, estimateCost, summarizeRun, MODELS, PRICING, HARNESS_VERSION, TEMPLATE_HASH } from "./lab.js";

const SPEC_DOC =
  "Spec shape: {tasks:[{id?, prompt, check:{type:'contains'|'regex'|'number'|'judge', value?, rubric?, tolerance?}}] (1-8), " +
  "variants:[{id?, label?, provider?:'anthropic'|'vllm', model?, pod_id?, pattern:'single'|'plan'|'critique'|'bestofN', n?, " +
  "effort?:'low'|'medium'|'high'|'xhigh', thinking?:'adaptive'|'off', maxTokens?}] (1-6), trials?:1-3, budgetCapUsd?:0.5-50 (default 10), " +
  `problem_class?:'extraction'|'drafting'|'classification'|'conversation'|'routing'}. Anthropic models: ${MODELS.join(", ")}. ` +
  "Open weights: provision a pod first, then use provider:'vllm' + pod_id (effort/thinking don't apply there). " +
  "variants[0] is the BASELINE — leverage is measured against it (R1: hold the harness constant when the model is the variable).";

export const TOOL_DEFS = [
  {
    name: "list_library",
    description: "List saved studies, benchmarks, problems, and live pods (ids, names, status). Call before creating or referencing artifacts so you reuse instead of duplicating.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "list_models",
    description: "The model surface: Anthropic API models with $/MTok pricing, the curated open-weight roster (HF refs + GPU tier + est. $/hr), and currently provisioned pods.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_study",
    description: "Read a study: its notes with sources.",
    input_schema: { type: "object", properties: { study_id: { type: "string" } }, required: ["study_id"] }
  },
  {
    name: "save_study_note",
    description: "Save a research note into a study (the durable corpus). Use after ingesting a link, doing web research, or when the user shares information worth keeping. Pass study_id to append (check list_library first); otherwise study_title creates one. Always include source URLs.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string" },
        study_title: { type: "string" },
        note_title: { type: "string" },
        content: { type: "string", description: "markdown, <=4000 chars, distilled not dumped" },
        sources: { type: "array", items: { type: "string" } }
      },
      required: ["note_title", "content"]
    }
  },
  {
    name: "get_benchmark",
    description: "Read a benchmark: spec (with version/frozen state), run history, latest measured metrics.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  {
    name: "create_benchmark",
    description: "Create (save) a benchmark experiment definition. Returns validation errors or {bench_id, estimated_calls, estimated_cost_usd}. Propose the spec to the user BEFORE creating; create after they agree. " + SPEC_DOC,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        hypothesis: { type: "string", description: "what this experiment should decide" },
        spec: { type: "object", description: "tasks/variants/trials grid — see tool description" }
      },
      required: ["name", "spec"]
    }
  },
  {
    name: "amend_benchmark",
    description: "R2: benchmarks freeze on first run and are NEVER edited. This creates version N+1 with a parent link (new bench_id); the frozen version and its history stay runnable forever. Use to iterate on tasks/variants/scoring.",
    input_schema: {
      type: "object",
      properties: {
        bench_id: { type: "string", description: "the version to amend from" },
        spec: { type: "object", description: "the replacement spec (full, not a patch)" },
        hypothesis: { type: "string" },
        name: { type: "string" }
      },
      required: ["bench_id", "spec"]
    }
  },
  {
    name: "run_benchmark",
    description: "Execute a saved benchmark NOW against live model endpoints (cap ~30 model calls synchronously; the run also aborts at its budgetCapUsd). Streams progress. Returns measured metrics per variant: pass rate with 95% CI, tokens, $, cost-of-pass, latency, convergence, leverage, served-model strings. State projected cost before calling this; confirm with the user above ~$0.50.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  {
    name: "queue_benchmark",
    description: "Queue a benchmark for the hourly cron worker (bigger budget, ~60-call cap, 15-min window). Use for grids too large to run synchronously.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  {
    name: "get_report",
    description: "Fetch a run report by run_id or bench_id (latest run): the quadruple (quality + cost + time + uncertainty) per variant, harness identity, drift-relevant provenance (served model strings).",
    input_schema: { type: "object", properties: { run_id: { type: "string" }, bench_id: { type: "string" } } }
  },
  {
    name: "list_problems",
    description: "List Forward Flow problem intake entries (directive §5).",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "submit_problem",
    description: "Capture a Forward Flow problem into the intake registry before it evaporates (directive §5). Fields: name, problem_class (extraction|drafting|classification|conversation|routing), description, input_spec, gold_output_spec, latency_tolerance (batch|interactive|realtime-voice), data_sensitivity (public|client|borrower-PII), volume_estimate, current_solution, gold_set_status.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, problem_class: { type: "string" }, description: { type: "string" },
        input_spec: { type: "string" }, gold_output_spec: { type: "string" },
        latency_tolerance: { type: "string" }, data_sensitivity: { type: "string" },
        volume_estimate: { type: "string" }, current_solution: { type: "string" }, gold_set_status: { type: "string" }
      },
      required: ["name", "problem_class", "description"]
    }
  },
  {
    name: "provision_pod",
    description: "Provision a RunPod GPU pod serving an open-weight model via vLLM (OpenAI-compatible). Tiers: 24gb (~$0.3-0.7/hr, ≤8B fp16), 48gb (~$0.8-1.3/hr, ~13-24B), 80gb (~$1.6-3.5/hr, 32B fp16 / 70B 4-bit). TTL default 2h (max 8h) — the hourly reaper terminates expired pods. Returns immediately; weights load for ~3-15 min — poll pod_status until ready:true before benchmarking. ALWAYS state the $/hr and TTL to the user. Requires RUNPOD_API_KEY.",
    input_schema: {
      type: "object",
      properties: {
        model_ref: { type: "string", description: "HF repo id, e.g. Qwen/Qwen3-8B (see list_models roster)" },
        tier: { type: "string", description: "24gb | 48gb | 80gb" },
        ttl_hours: { type: "number", description: "auto-terminate after this many hours (default 2, max 8)" },
        max_model_len: { type: "number", description: "vLLM --max-model-len (default 8192)" },
        extra_args: { type: "array", items: { type: "string" }, description: "extra vLLM args, e.g. [\"--quantization\",\"awq\"] — quantized variants are separate registry entries per directive §3" }
      },
      required: ["model_ref"]
    }
  },
  {
    name: "pod_status",
    description: "Check a pod: RunPod status, vLLM readiness (ready:true means /v1/models answers), served model id, $/hr, age, spend so far.",
    input_schema: { type: "object", properties: { pod_id: { type: "string" } }, required: ["pod_id"] }
  },
  {
    name: "list_pods",
    description: "List provisioned pods with age, TTL expiry, and rates.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "terminate_pod",
    description: "Terminate a pod (directive §4 step 5: tear down after the experiment). Reports approximate spend. Do this proactively when a pod's work is done — don't wait for the TTL reaper.",
    input_schema: { type: "object", properties: { pod_id: { type: "string" } }, required: ["pod_id"] }
  },
  {
    name: "get_calibration_map",
    description: "The anchor→our-problems calibration map for a problem class (directive §2). Returns measured vectors per model and honest status — it reports insufficient-data until enough models share Class A + Class B runs.",
    input_schema: { type: "object", properties: { problem_class: { type: "string" } } }
  },
  {
    name: "get_digest",
    description: "Latest weekly scan digest (models + papers/techniques, directive §3), or none-yet.",
    input_schema: { type: "object", properties: {} }
  }
];

// Anthropic server tools appended for the chat agent only (MCP clients bring their own web).
export const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 }
];

// ── executor ─────────────────────────────────────────────────────────────────
export async function execTool(env, name, input, emit = () => {}) {
  switch (name) {
    case "list_library": {
      const [studies, benches, problems, livePods] = await Promise.all([
        store.listStudies(env), store.listBenches(env), store.listProblems(env), pods.listPods(env)
      ]);
      return JSON.stringify({ studies, benchmarks: benches, problems, pods: livePods });
    }
    case "list_models": {
      return JSON.stringify({
        anthropic: MODELS.map((m) => ({ model: m, usd_per_mtok: PRICING[m] })),
        open_weight_roster: pods.ROSTER,
        gpu_tiers: pods.GPU_TIERS,
        pods: await pods.listPods(env),
        runpod_enabled: pods.hasRunpod(env),
        note: "roster entries are suggestions from the directive §3 — provision_pod accepts any HF repo; verify latest generations via the weekly scan"
      });
    }
    case "get_study": {
      const s = await store.getStudy(env, String(input.study_id || ""));
      if (!s) return JSON.stringify({ error: "study not found" });
      return JSON.stringify({ ...s, notes: s.notes.map((n) => ({ ...n, content: n.content.slice(0, 1500) })) });
    }
    case "save_study_note": {
      const study = await store.addNote(env, {
        studyId: input.study_id, studyTitle: input.study_title,
        title: input.note_title, content: input.content, sources: input.sources, origin: "chat"
      });
      emit({ t: "artifact", kind: "study", id: study.id });
      return JSON.stringify({ ok: true, study_id: study.id, study_title: study.title, notes: study.notes.length });
    }
    case "get_benchmark": {
      const b = await store.getBench(env, String(input.bench_id || ""));
      if (!b) return JSON.stringify({ error: "benchmark not found" });
      const latest = b.runs[0];
      return JSON.stringify({
        id: b.id, name: b.name, version: b.version, parentId: b.parentId, frozen: b.frozen,
        hypothesis: b.hypothesis, spec: b.spec,
        runs: b.runs.map((r) => ({ id: r.id, ts: r.ts, status: r.status, totals: r.totals, harness: r.harness })),
        latest_run: latest
          ? { id: latest.id, ts: latest.ts, status: latest.status, totals: latest.totals, harness: latest.harness,
              variants: (latest.variants || []).map((v) => ({ id: v.id, label: v.label, provider: v.provider, model: v.model, pod_id: v.pod_id, pattern: v.pattern, effort: v.effort, metrics: v.metrics })) }
          : null
      });
    }
    case "create_benchmark": {
      const { spec, errors, estimatedCalls } = validateSpec(input.spec || {});
      if (errors.length) return JSON.stringify({ ok: false, errors });
      const bench = await store.createBench(env, { name: input.name, hypothesis: input.hypothesis, spec });
      emit({ t: "artifact", kind: "bench", id: bench.id });
      return JSON.stringify({ ok: true, bench_id: bench.id, version: bench.version, estimated_calls: estimatedCalls, estimated_cost_usd: estimateCost(spec), budget_cap_usd: spec.budgetCapUsd });
    }
    case "amend_benchmark": {
      const { spec, errors } = validateSpec(input.spec || {});
      if (errors.length) return JSON.stringify({ ok: false, errors });
      const bench = await store.amendBench(env, String(input.bench_id || ""), { spec, hypothesis: input.hypothesis, name: input.name });
      if (!bench) return JSON.stringify({ error: "parent benchmark not found" });
      emit({ t: "artifact", kind: "bench", id: bench.id });
      return JSON.stringify({ ok: true, bench_id: bench.id, version: bench.version, parent_id: bench.parentId, estimated_cost_usd: estimateCost(spec) });
    }
    case "run_benchmark": {
      const bench = await store.getBench(env, String(input.bench_id || ""));
      if (!bench) return JSON.stringify({ error: "benchmark not found" });
      const run = await runBenchmark(env, bench, { onProgress: (s) => emit({ t: "progress", s }), callCap: 30 });
      await store.addRun(env, bench.id, run);
      emit({ t: "artifact", kind: "bench", id: bench.id });
      if (run.status !== "done" && run.status !== "partial-budget")
        return JSON.stringify({ ok: false, status: run.status, errors: run.errors });
      return JSON.stringify({
        ok: true, run_id: run.id, status: run.status, totals: run.totals, wall_ms: run.wallMs, harness: run.harness,
        summary: summarizeRun(bench, run),
        variants: run.variants.map((v) => ({ id: v.id, label: v.label, provider: v.provider, model: v.model, pod_id: v.pod_id, pattern: v.pattern, effort: v.effort, metrics: v.metrics }))
      });
    }
    case "queue_benchmark": {
      const bench = await store.getBench(env, String(input.bench_id || ""));
      if (!bench) return JSON.stringify({ error: "benchmark not found" });
      const n = await store.queuePush(env, bench.id);
      return JSON.stringify({ ok: true, queued: true, queue_length: n, note: "the hourly cron will run it (cap ~60 calls, 15-min window)" });
    }
    case "get_report": {
      let benchId = input.bench_id ? String(input.bench_id) : null;
      let runId = input.run_id ? String(input.run_id) : null;
      if (!benchId && runId) benchId = await store.benchIdForRun(env, runId);
      if (!benchId) return JSON.stringify({ error: "provide run_id or bench_id" });
      const b = await store.getBench(env, benchId);
      if (!b) return JSON.stringify({ error: "benchmark not found" });
      const run = runId ? b.runs.find((r) => r.id === runId) : b.runs[0];
      if (!run) return JSON.stringify({ error: "no runs for this benchmark yet" });
      return JSON.stringify({
        bench: { id: b.id, name: b.name, version: b.version, hypothesis: b.hypothesis, problem_class: b.spec?.problem_class },
        run: { ...run, cells: (run.cells || []).slice(0, 60) },
        summary: summarizeRun(b, run)
      });
    }
    case "list_problems":
      return JSON.stringify(await store.listProblems(env));
    case "submit_problem": {
      const p = await store.submitProblem(env, input);
      return JSON.stringify({ ok: true, problem: p });
    }
    case "provision_pod": {
      if (!pods.hasRunpod(env)) return JSON.stringify({ error: "RUNPOD_API_KEY not set — ask the operator to add the secret (npx wrangler secret put RUNPOD_API_KEY); provisioning is disabled until then" });
      const entry = await pods.provisionPod(env, {
        modelRef: String(input.model_ref || ""), tier: input.tier || "24gb",
        ttlHours: input.ttl_hours, maxModelLen: input.max_model_len, extraArgs: input.extra_args || []
      });
      emit({ t: "progress", s: `pod ${entry.id} created: ${entry.modelRef} on ${entry.tier} at $${entry.costPerHr}/hr, TTL ${entry.ttlHours}h` });
      return JSON.stringify({ ok: true, pod: entry, note: "weights are loading (~3-15 min depending on size) — poll pod_status until ready:true, then reference this pod_id in benchmark variants with provider:'vllm'" });
    }
    case "pod_status":
      return JSON.stringify(await pods.podStatus(env, String(input.pod_id || "")));
    case "list_pods":
      return JSON.stringify({ pods: await pods.listPods(env), runpod_enabled: pods.hasRunpod(env) });
    case "terminate_pod": {
      if (!pods.hasRunpod(env)) return JSON.stringify({ error: "RUNPOD_API_KEY not set" });
      return JSON.stringify(await pods.terminatePod(env, String(input.pod_id || "")));
    }
    case "get_calibration_map": {
      const benches = await store.listBenches(env);
      const full = await Promise.all(benches.slice(0, 30).map((b) => store.getBench(env, b.id)));
      const byClass = {};
      for (const b of full) {
        if (!b || !b.runs.length) continue;
        const cls = b.spec?.problem_class || "unclassified";
        if (input.problem_class && cls !== input.problem_class) continue;
        const run = b.runs[0];
        for (const v of run.variants || []) {
          const key = v.model || (v.metrics?.servedModels || [])[0] || v.pod_id;
          if (!key) continue;
          (byClass[cls] = byClass[cls] || {})[key] = (byClass[cls][key] || []).concat([{
            bench: b.name + " v" + b.version, passRate: v.metrics.passRate, passCI95: v.metrics.passCI95,
            costOfPass: v.metrics.costOfPass, pattern: v.pattern, n: v.metrics.trials
          }]);
        }
      }
      const modelsMeasured = new Set(Object.values(byClass).flatMap((m) => Object.keys(m))).size;
      return JSON.stringify({
        status: modelsMeasured >= 10 ? "fit-eligible" : "insufficient-data",
        models_measured: modelsMeasured,
        note: "Class A anchors are not yet replicated on this deployment; until ≥10 models share anchor + Class B runs, this map reports raw vectors and rank ordering only — no fitted predictions (directive amendment: no overfitting theater).",
        vectors: byClass
      });
    }
    case "get_digest": {
      const studies = await store.listStudies(env);
      const dig = studies.find((s) => /digest/i.test(s.title));
      if (!dig) return JSON.stringify({ status: "none-yet", note: "the weekly scan runs Mondays 13:00 UTC (cron); a digest study will appear after the first run" });
      const s = await store.getStudy(env, dig.id);
      const latest = s.notes[0];
      return JSON.stringify({ study_id: s.id, latest: latest ? { title: latest.title, ts: latest.ts, content: latest.content, sources: latest.sources } : null });
    }
    default:
      return JSON.stringify({ error: "unknown tool " + name });
  }
}

// ── weekly scan (directive §3): models + papers digest, saved to a study ─────
export async function runWeeklyDigest(env) {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "no-key" };
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 80000, maxRetries: 1 });
  const problems = await store.listProblems(env);
  const classes = [...new Set(problems.map((p) => p.problem_class))].join(", ") || "extraction, classification";
  let msg;
  try {
    msg = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 3000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: "You are intellistudy's weekly scanner. Primary sources only; cite a URL per item; never invent standings.",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: [{
        role: "user",
        content:
          `Weekly scan (directive §3). Problem classes in scope: ${classes}.\n` +
          "1) New open-weight or API model releases this week relevant to those classes — top 3 candidates with one line each on why + which GPU tier they'd need.\n" +
          "2) Papers/techniques/harness releases — max 5 items, one line each on relevance.\n" +
          "Keep the whole digest under 300 words. Cite a source URL for every item. Do NOT recommend running anything — candidates are logged for approval."
      }]
    });
  } catch (e) {
    return { ok: false, reason: (e?.message || String(e)).slice(0, 200) };
  }
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) return { ok: false, reason: "empty digest" };
  const urls = [...text.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0]).slice(0, 12);
  const studies = await store.listStudies(env);
  const dig = studies.find((s) => /^Weekly digests$/i.test(s.title));
  await store.addNote(env, {
    studyId: dig ? dig.id : undefined,
    studyTitle: "Weekly digests",
    title: "Weekly scan " + new Date().toISOString().slice(0, 10),
    content: text.slice(0, 7000),
    sources: urls,
    origin: "scheduled-scan"
  });
  return { ok: true };
}
