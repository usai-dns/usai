// lab.js — the experiment runner: the part of intellistudy that MEASURES.
//
// A benchmark spec is a grid: tasks × variants × trials. A variant is a concrete
// architecture choice — model × harness pattern × effort. The runner executes
// every cell against the real Anthropic API and meters every call, producing:
//
//   token cost    — input/output tokens actually billed (incl. cache fields)
//   dollar cost   — from the pricing table below
//   latency       — wall-clock per call
//   pass rate     — objective checkers (contains/regex/number) or a cheap judge
//   cost-of-pass  — variant $ cost / passes (the project's founding metric)
//   convergence   — trial agreement (same verdict across trials) and, for
//                   critique patterns, settled-rate (did revision stop moving)
//   leverage      — Δ pass-rate per Δ $ vs the baseline variant (variants[0]):
//                   what an architectural upgrade buys per marginal dollar
//
// Harness patterns (implemented here, so they're measurable, comparable code):
//   single    — one call
//   plan      — plan briefly, then execute with the plan   (2 calls)
//   critique  — draft, then self-critique + final          (2 calls)
//   bestofN   — n parallel drafts + a cheap picker         (n+1 calls)
// Pattern overhead (extra calls, picker cost) is charged to the variant — that
// is the honest accounting that makes leverage meaningful.

import Anthropic from "@anthropic-ai/sdk";

// $ per MTok — in/out (+ cache read ≈0.1×in, cache write ≈1.25×in).
export const PRICING = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 }
};
export const MODELS = Object.keys(PRICING);
const JUDGE_MODEL = "claude-haiku-4-5"; // checker/picker — cheap, metered separately where noted
const PATTERNS = ["single", "plan", "critique", "bestofN"];

export function costOf(model, usage) {
  const p = PRICING[model] || PRICING["claude-sonnet-4-6"];
  const inTok = usage?.input_tokens || 0;
  const outTok = usage?.output_tokens || 0;
  const cacheR = usage?.cache_read_input_tokens || 0;
  const cacheW = usage?.cache_creation_input_tokens || 0;
  return (inTok * p.in + outTok * p.out + cacheR * p.in * 0.1 + cacheW * p.in * 1.25) / 1e6;
}

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 80000, maxRetries: 1 });
}

// One metered model call, with per-model parameter shaping:
//  - haiku: no effort param, no thinking (unsupported/legacy surface)
//  - fable-5: thinking always on — never send the param
//  - opus/sonnet: adaptive thinking unless variant says off; effort supported
async function callModel(env, { model, system, messages, effort, thinking, maxTokens }) {
  const req = { model, max_tokens: maxTokens || 2000, messages };
  if (system) req.system = system;
  const isHaiku = model.includes("haiku");
  const isFable = model.includes("fable") || model.includes("mythos");
  if (!isHaiku) {
    if (effort) req.output_config = { effort };
    if (!isFable && thinking !== "off") req.thinking = { type: "adaptive" };
  }
  const t0 = Date.now();
  const msg = await client(env).messages.create(req);
  const ms = Date.now() - t0;
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return {
    text,
    refused: msg.stop_reason === "refusal",
    usage: msg.usage || {},
    ms,
    cost: costOf(model, msg.usage)
  };
}

// ── spec validation ──────────────────────────────────────────────────────────
export function validateSpec(raw) {
  const errors = [];
  const spec = { tasks: [], variants: [], trials: 1 };
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks.slice(0, 8) : [];
  const variants = Array.isArray(raw?.variants) ? raw.variants.slice(0, 6) : [];
  if (!tasks.length) errors.push("spec.tasks is required (1-8 tasks)");
  if (!variants.length) errors.push("spec.variants is required (1-6 variants)");
  spec.trials = Math.max(1, Math.min(3, Number(raw?.trials) || 1));

  tasks.forEach((t, i) => {
    const id = String(t.id || "t" + (i + 1));
    const prompt = String(t.prompt || "").slice(0, 4000);
    if (!prompt) errors.push(`task ${id}: prompt required`);
    const c = t.check || {};
    const type = ["contains", "regex", "number", "judge"].includes(c.type) ? c.type : null;
    if (!type) errors.push(`task ${id}: check.type must be contains|regex|number|judge`);
    if (type === "judge" && !c.rubric) errors.push(`task ${id}: judge check needs check.rubric`);
    if ((type === "contains" || type === "regex" || type === "number") && c.value === undefined)
      errors.push(`task ${id}: check.value required for ${type}`);
    spec.tasks.push({ id, prompt, check: { type, value: c.value !== undefined ? String(c.value) : undefined, rubric: c.rubric ? String(c.rubric).slice(0, 800) : undefined, tolerance: Number(c.tolerance) || 0 } });
  });

  variants.forEach((v, i) => {
    const id = String(v.id || "v" + (i + 1));
    const model = MODELS.includes(v.model) ? v.model : null;
    if (!model) errors.push(`variant ${id}: model must be one of ${MODELS.join(", ")}`);
    const pattern = PATTERNS.includes(v.pattern) ? v.pattern : "single";
    const n = pattern === "bestofN" ? Math.max(2, Math.min(4, Number(v.n) || 2)) : undefined;
    const effort = ["low", "medium", "high", "xhigh", "max"].includes(v.effort) ? v.effort : undefined;
    spec.variants.push({
      id, model, pattern, n, effort,
      thinking: v.thinking === "off" ? "off" : "adaptive",
      maxTokens: Math.max(256, Math.min(8000, Number(v.maxTokens) || 1500)),
      label: v.label ? String(v.label).slice(0, 80) : undefined
    });
  });

  // call budget: pattern call-counts × tasks × trials (+ judge checks)
  const callsPerVariant = (v) => (v.pattern === "single" ? 1 : v.pattern === "bestofN" ? v.n + 1 : 2);
  const modelCalls = spec.variants.reduce((a, v) => a + callsPerVariant(v), 0) * spec.tasks.length * spec.trials;
  const judgeCalls = spec.tasks.filter((t) => t.check.type === "judge").length * spec.variants.length * spec.trials;
  spec.estimatedCalls = modelCalls + judgeCalls;
  return { spec, errors, estimatedCalls: spec.estimatedCalls };
}

// Rough worst-case $ estimate for confirmation before running.
export function estimateCost(spec) {
  let dollars = 0;
  for (const v of spec.variants) {
    const per = (v.pattern === "single" ? 1 : v.pattern === "bestofN" ? v.n + 1 : 2);
    const p = PRICING[v.model];
    // assume ~1.2k in / maxTokens out worst case per call
    dollars += per * spec.tasks.length * spec.trials * ((1200 * p.in + v.maxTokens * p.out) / 1e6);
  }
  return Math.round(dollars * 1000) / 1000;
}

// ── checkers ─────────────────────────────────────────────────────────────────
function extractNumbers(s) {
  return (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}
async function runCheck(env, check, text) {
  if (check.type === "contains")
    return { pass: text.toLowerCase().includes(String(check.value).toLowerCase()), evalCost: 0 };
  if (check.type === "regex") {
    try { return { pass: new RegExp(check.value, "i").test(text), evalCost: 0 }; }
    catch { return { pass: false, evalCost: 0, note: "bad regex" }; }
  }
  if (check.type === "number") {
    const want = Number(check.value);
    const tol = check.tolerance || Math.abs(want) * 0.001;
    const pass = extractNumbers(text).some((n) => Math.abs(n - want) <= tol);
    return { pass, evalCost: 0 };
  }
  if (check.type === "judge") {
    const r = await callModel(env, {
      model: JUDGE_MODEL,
      system: "You are a strict evaluator. Reply with exactly PASS or FAIL — nothing else.",
      messages: [{ role: "user", content: `Rubric: ${check.rubric}\n\nAnswer to evaluate:\n${text.slice(0, 4000)}\n\nPASS or FAIL?` }],
      maxTokens: 8
    });
    return { pass: /\bPASS\b/i.test(r.text), evalCost: r.cost };
  }
  return { pass: false, evalCost: 0 };
}

// ── harness patterns ─────────────────────────────────────────────────────────
const SYS = "You are being benchmarked. Answer the task directly and completely. No preamble.";

function similar(a, b) {
  // crude token-overlap similarity for "did the revision actually move"
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

async function runPattern(env, variant, prompt) {
  const base = { model: variant.model, effort: variant.effort, thinking: variant.thinking, maxTokens: variant.maxTokens, system: SYS };
  const calls = [];
  let finalText = "", revised = null;

  if (variant.pattern === "single") {
    const r = await callModel(env, { ...base, messages: [{ role: "user", content: prompt }] });
    calls.push(r); finalText = r.text;
  } else if (variant.pattern === "plan") {
    const p = await callModel(env, { ...base, maxTokens: 600, messages: [{ role: "user", content: `Plan how to solve this in at most 5 short bullets. Do NOT solve it yet.\n\nTask: ${prompt}` }] });
    calls.push(p);
    const r = await callModel(env, { ...base, messages: [{ role: "user", content: `Task: ${prompt}\n\nYour plan:\n${p.text}\n\nNow execute the plan and give the final answer.` }] });
    calls.push(r); finalText = r.text;
  } else if (variant.pattern === "critique") {
    const d = await callModel(env, { ...base, messages: [{ role: "user", content: prompt }] });
    calls.push(d);
    const r = await callModel(env, { ...base, messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: d.text || "(empty)" },
      { role: "user", content: "Critique your answer above for errors, then give your FINAL answer only." }
    ]});
    calls.push(r); finalText = r.text;
    revised = similar(d.text, r.text) < 0.85; // materially changed?
  } else if (variant.pattern === "bestofN") {
    const drafts = await Promise.all(
      Array.from({ length: variant.n }, () => callModel(env, { ...base, messages: [{ role: "user", content: prompt }] }))
    );
    calls.push(...drafts);
    const listing = drafts.map((d, i) => `--- Candidate ${i + 1} ---\n${d.text.slice(0, 1500)}`).join("\n\n");
    const pick = await callModel(env, {
      model: JUDGE_MODEL, maxTokens: 8, system: "Reply with only the number of the best candidate.",
      messages: [{ role: "user", content: `Task: ${prompt}\n\n${listing}\n\nBest candidate number:` }]
    });
    calls.push(pick); // picker cost is harness cost — charged to the variant
    const idx = Math.min(Math.max(parseInt((pick.text.match(/\d+/) || ["1"])[0], 10) - 1, 0), variant.n - 1);
    finalText = drafts[idx].text;
  }

  return {
    finalText,
    revised,
    refused: calls.some((c) => c.refused),
    calls: calls.length,
    tokensIn: calls.reduce((a, c) => a + (c.usage.input_tokens || 0) + (c.usage.cache_read_input_tokens || 0) + (c.usage.cache_creation_input_tokens || 0), 0),
    tokensOut: calls.reduce((a, c) => a + (c.usage.output_tokens || 0), 0),
    cost: calls.reduce((a, c) => a + c.cost, 0),
    ms: calls.reduce((a, c) => a + c.ms, 0)
  };
}

// ── the runner ───────────────────────────────────────────────────────────────
// Executes the grid with a small concurrency pool; onProgress(str) streams
// human-readable progress lines to whoever is watching (chat, cron log).
export async function runBenchmark(env, bench, { onProgress = () => {}, callCap = 30 } = {}) {
  const { spec, errors } = validateSpec(bench.spec);
  if (errors.length) return { id: newRunId(), ts: new Date().toISOString(), status: "invalid", errors };
  if (spec.estimatedCalls > callCap)
    return { id: newRunId(), ts: new Date().toISOString(), status: "too-large", errors: [`estimated ${spec.estimatedCalls} model calls exceeds cap ${callCap} — trim the spec or queue it for the nightly run`] };

  const t0 = Date.now();
  const cells = [];
  for (const v of spec.variants) for (const t of spec.tasks) for (let k = 0; k < spec.trials; k++) cells.push({ v, t, trial: k + 1 });

  const results = [];
  let done = 0;
  const pool = 4;
  onProgress(`running ${cells.length} cells (${spec.estimatedCalls} model calls) across ${spec.variants.length} variants…`);
  for (let i = 0; i < cells.length; i += pool) {
    const batch = cells.slice(i, i + pool);
    const settled = await Promise.all(batch.map(async ({ v, t, trial }) => {
      try {
        const run = await runPattern(env, v, t.prompt);
        const check = run.refused ? { pass: false, evalCost: 0, note: "refused" } : await runCheck(env, t.check, run.finalText);
        return { variantId: v.id, taskId: t.id, trial, pass: !!check.pass, revised: run.revised, refused: run.refused,
                 tokensIn: run.tokensIn, tokensOut: run.tokensOut, cost: run.cost, evalCost: check.evalCost, ms: run.ms,
                 answer: (run.finalText || "").slice(0, 280) };
      } catch (e) {
        return { variantId: v.id, taskId: t.id, trial, pass: false, error: (e?.message || String(e)).slice(0, 200),
                 tokensIn: 0, tokensOut: 0, cost: 0, evalCost: 0, ms: 0 };
      }
    }));
    results.push(...settled);
    done += batch.length;
    onProgress(`  ${done}/${cells.length} cells done`);
  }

  // ── aggregate per variant ──
  const variants = spec.variants.map((v) => {
    const rows = results.filter((r) => r.variantId === v.id);
    const passes = rows.filter((r) => r.pass).length;
    const cost = rows.reduce((a, r) => a + r.cost, 0);
    const m = {
      trials: rows.length,
      passes,
      passRate: rows.length ? passes / rows.length : 0,
      tokensIn: rows.reduce((a, r) => a + r.tokensIn, 0),
      tokensOut: rows.reduce((a, r) => a + r.tokensOut, 0),
      cost: round(cost),
      avgLatencyMs: rows.length ? Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length) : 0,
      costOfPass: passes ? round(cost / passes) : null,
      errors: rows.filter((r) => r.error).length
    };
    // convergence: trial agreement when trials>1; critique settled-rate otherwise
    if (spec.trials > 1) {
      const byTask = {};
      rows.forEach((r) => { (byTask[r.taskId] = byTask[r.taskId] || []).push(r.pass); });
      const tasks = Object.values(byTask);
      m.convergence = tasks.length ? round(tasks.filter((arr) => arr.every((p) => p === arr[0])).length / tasks.length) : null;
      m.convergenceKind = "trial-agreement";
    } else if (v.pattern === "critique") {
      const rev = rows.filter((r) => r.revised !== null && r.revised !== undefined);
      m.convergence = rev.length ? round(rev.filter((r) => !r.revised).length / rev.length) : null;
      m.convergenceKind = "settled-rate";
    } else {
      m.convergence = null;
      m.convergenceKind = "n/a (1 trial, single-shot)";
    }
    return { ...v, metrics: m };
  });

  // leverage vs baseline (variants[0])
  const base = variants[0].metrics;
  for (const v of variants) {
    const dPass = v.metrics.passRate - base.passRate;
    const dCost = v.metrics.cost - base.cost;
    v.metrics.deltaPassRate = round(dPass);
    v.metrics.deltaCost = round(dCost);
    if (v === variants[0]) v.metrics.leverage = "baseline";
    else if (dCost > 0.000001) v.metrics.leverage = round(dPass / dCost); // Δpass-rate per extra $
    else if (dPass >= 0) v.metrics.leverage = "dominates"; // better or equal, cheaper
    else v.metrics.leverage = "dominated"; // worse and cheaper/equal
  }

  return {
    id: newRunId(),
    ts: new Date().toISOString(),
    status: "done",
    wallMs: Date.now() - t0,
    totals: {
      calls: spec.estimatedCalls,
      cost: round(results.reduce((a, r) => a + r.cost, 0)),
      evalCost: round(results.reduce((a, r) => a + r.evalCost, 0)),
      tokensIn: results.reduce((a, r) => a + r.tokensIn, 0),
      tokensOut: results.reduce((a, r) => a + r.tokensOut, 0)
    },
    variants,
    cells: results
  };
}

function round(n) { return typeof n === "number" ? Math.round(n * 10000) / 10000 : n; }
function newRunId() { return crypto.randomUUID().slice(0, 8); }

// Compact text summary of a run for the chat model / logs.
export function summarizeRun(bench, run) {
  if (run.status !== "done") return `run ${run.id}: ${run.status} — ${(run.errors || []).join("; ")}`;
  const lines = [`run ${run.id} of "${bench.name}" — ${run.totals.calls} calls, $${run.totals.cost} (+$${run.totals.evalCost} eval), ${Math.round(run.wallMs / 1000)}s`];
  for (const v of run.variants) {
    const m = v.metrics;
    lines.push(
      `  ${v.id} [${v.model} · ${v.pattern}${v.n ? v.n : ""}${v.effort ? " · " + v.effort : ""}]: ` +
      `pass ${m.passes}/${m.trials} (${Math.round(m.passRate * 100)}%) · $${m.cost} · cost-of-pass ${m.costOfPass === null ? "∞" : "$" + m.costOfPass} · ` +
      `tok ${m.tokensIn}/${m.tokensOut} · ${m.avgLatencyMs}ms avg · convergence ${m.convergence === null ? "n/a" : m.convergence} (${m.convergenceKind}) · leverage ${m.leverage}`
    );
  }
  return lines.join("\n");
}
