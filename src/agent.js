// agent.js — the chat agent: Claude with lab tools.
//
// This is the core of v2: the chat isn't a commentary layer, it OPERATES the
// lab. The assistant holds client-side tools implemented against store.js and
// lab.js — save research into studies, design benchmark specs, execute runs,
// read results — plus Anthropic's server-side web_search/web_fetch for
// ingesting links and doing its own research.
//
// Transport: an NDJSON stream of events the UI renders incrementally:
//   {t:"meta", threadId, title}      first line — which thread this turn is in
//   {t:"delta", s}                   assistant text token(s)
//   {t:"tool", name, label}          a tool call started
//   {t:"progress", s}                benchmark-runner progress line
//   {t:"artifact", kind, id}         a study/benchmark/run was created/updated
//   {t:"error", s}                   something failed (turn continues/ends)
//   {t:"done"}                       turn complete (thread persisted)

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { runBenchmark, validateSpec, estimateCost, summarizeRun, MODELS } from "./lab.js";

export const CHAT_MODEL = "claude-opus-4-8";

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 80000, maxRetries: 1 });
}
export function hasKey(env) {
  return Boolean(env && env.ANTHROPIC_API_KEY);
}

// ── tool definitions ─────────────────────────────────────────────────────────
const SPEC_DOC =
  "Spec shape: {tasks:[{id?, prompt, check:{type:'contains'|'regex'|'number'|'judge', value?, rubric?, tolerance?}}] (1-8), " +
  "variants:[{id?, label?, model, pattern:'single'|'plan'|'critique'|'bestofN', n?, effort?:'low'|'medium'|'high'|'xhigh', thinking?:'adaptive'|'off', maxTokens?}] (1-6), " +
  `trials?:1-3}. Models: ${MODELS.join(", ")}. ` +
  "variants[0] is the BASELINE — leverage is measured against it. Design controlled comparisons: isolate ONE dimension " +
  "(model OR pattern OR effort) per benchmark. Prefer objective checks (contains/regex/number); use judge only when necessary.";

const TOOLS = [
  {
    name: "list_library",
    description: "List saved studies and benchmarks (ids, names, dates). Call this before creating or referencing artifacts so you reuse existing ones instead of duplicating.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_study",
    description: "Read a study: its notes with sources.",
    input_schema: { type: "object", properties: { study_id: { type: "string" } }, required: ["study_id"] }
  },
  {
    name: "save_study_note",
    description: "Save a research note into a study (the durable research corpus). Use after ingesting a link, doing web research, or when the user shares information worth keeping. Pass study_id to append to an existing study (check list_library first); otherwise pass study_title to create one. Always include source URLs.",
    input_schema: {
      type: "object",
      properties: {
        study_id: { type: "string", description: "existing study to append to" },
        study_title: { type: "string", description: "title for a new study if no study_id" },
        note_title: { type: "string" },
        content: { type: "string", description: "markdown, <=4000 chars, distilled not dumped" },
        sources: { type: "array", items: { type: "string" }, description: "URLs backing this note" }
      },
      required: ["note_title", "content"]
    }
  },
  {
    name: "get_benchmark",
    description: "Read a benchmark: spec, run history, and the latest run's measured metrics.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  {
    name: "create_benchmark",
    description: "Create (save) a benchmark experiment. Returns validation errors or {bench_id, estimated_calls, estimated_cost_usd}. Propose the spec to the user BEFORE creating it; create after they agree. " + SPEC_DOC,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        hypothesis: { type: "string", description: "what this experiment should decide" },
        spec: { type: "object", description: "the tasks/variants/trials grid — see tool description" }
      },
      required: ["name", "spec"]
    }
  },
  {
    name: "run_benchmark",
    description: "Execute a saved benchmark NOW against the real APIs (cap ~30 model calls; larger specs must be queued). Streams progress; returns measured metrics per variant (pass rate, tokens, $ cost, cost-of-pass, latency, convergence, leverage). Confirm with the user before running anything estimated over $0.50.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  {
    name: "queue_benchmark",
    description: "Queue a benchmark for the nightly cron run (bigger budget, cap ~60 calls). Use for specs too large to run now.",
    input_schema: { type: "object", properties: { bench_id: { type: "string" } }, required: ["bench_id"] }
  },
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 }
];

// ── system prompt ────────────────────────────────────────────────────────────
function systemPrompt(library) {
  return (
    "You are intellistudy — a collaborative AI-architecture lab. Your operator is deciding which " +
    "LLM architectures (model × harness pattern × effort) to deploy against real problems. You turn " +
    "conversation into two kinds of durable, shared artifacts:\n" +
    "  • STUDIES — sourced research notes (from links the user shares, or your own web research).\n" +
    "  • BENCHMARKS — real measured experiments run against live model APIs.\n\n" +
    "Metrics you report (all MEASURED by the runner, never estimated by you):\n" +
    "  pass rate; token cost (in/out); dollar cost (from the pricing table); latency; " +
    "cost-of-pass = variant $ / passes; convergence = trial agreement across repeats (or settled-rate " +
    "for critique patterns); leverage = Δ pass-rate per extra $ vs the baseline variant (variants[0]) — " +
    "'dominates' means better and cheaper.\n\n" +
    "How to work:\n" +
    "- Links shared by the user → web_fetch them, distill, save_study_note with the URL as source.\n" +
    "- Research requests → web_search (prefer primary sources), then save a distilled, cited note.\n" +
    "- 'Compare / test / benchmark X' → design a compact controlled spec (baseline first, one dimension " +
    "varied, objective checks, 2-6 tasks), show it with the cost estimate, and once the user agrees: " +
    "create_benchmark, then run_benchmark (or queue if large).\n" +
    "- Analysis / 'what should I deploy' → read the saved runs (get_benchmark) and recommend an " +
    "architecture from the measured numbers. Flag small sample sizes honestly (2 tasks × 1 trial is a " +
    "smoke signal, not proof) and propose the follow-up experiment that would settle it.\n" +
    "- Never invent metrics or standings. If it wasn't measured by a run or found in a cited source, say so.\n\n" +
    "Style: lead with the outcome; be concise and concrete; plain prose (no arrow-chains); cite sources; " +
    "one clarifying question only when genuinely blocked, otherwise proceed and state assumptions.\n\n" +
    "Current library (ids you can reference):\n" + library
  );
}

function libraryDigest(studies, benches) {
  const s = studies.slice(0, 15).map((x) => `  study ${x.id}: "${x.title}" (${x.notes} notes)`).join("\n") || "  (no studies yet)";
  const b = benches.slice(0, 15).map((x) => `  bench ${x.id}: "${x.name}" (${x.runs} runs, ${x.lastStatus})`).join("\n") || "  (no benchmarks yet)";
  return "STUDIES:\n" + s + "\nBENCHMARKS:\n" + b;
}

// ── tool execution ───────────────────────────────────────────────────────────
async function execTool(env, name, input, emit) {
  if (name === "list_library") {
    const [studies, benches] = await Promise.all([store.listStudies(env), store.listBenches(env)]);
    return JSON.stringify({ studies, benchmarks: benches });
  }
  if (name === "get_study") {
    const s = await store.getStudy(env, String(input.study_id || ""));
    if (!s) return JSON.stringify({ error: "study not found" });
    return JSON.stringify({
      ...s,
      notes: s.notes.map((n) => ({ ...n, content: n.content.slice(0, 1500) }))
    });
  }
  if (name === "save_study_note") {
    const study = await store.addNote(env, {
      studyId: input.study_id,
      studyTitle: input.study_title,
      title: input.note_title,
      content: input.content,
      sources: input.sources,
      origin: "chat"
    });
    emit({ t: "artifact", kind: "study", id: study.id });
    return JSON.stringify({ ok: true, study_id: study.id, study_title: study.title, notes: study.notes.length });
  }
  if (name === "get_benchmark") {
    const b = await store.getBench(env, String(input.bench_id || ""));
    if (!b) return JSON.stringify({ error: "benchmark not found" });
    const latest = b.runs[0];
    return JSON.stringify({
      id: b.id, name: b.name, hypothesis: b.hypothesis, spec: b.spec,
      runs: b.runs.map((r) => ({ id: r.id, ts: r.ts, status: r.status, totals: r.totals })),
      latest_run: latest
        ? { id: latest.id, ts: latest.ts, status: latest.status, totals: latest.totals,
            variants: (latest.variants || []).map((v) => ({ id: v.id, label: v.label, model: v.model, pattern: v.pattern, effort: v.effort, metrics: v.metrics })) }
        : null
    });
  }
  if (name === "create_benchmark") {
    const { spec, errors, estimatedCalls } = validateSpec(input.spec || {});
    if (errors.length) return JSON.stringify({ ok: false, errors });
    const bench = await store.createBench(env, { name: input.name, hypothesis: input.hypothesis, spec });
    emit({ t: "artifact", kind: "bench", id: bench.id });
    return JSON.stringify({ ok: true, bench_id: bench.id, estimated_calls: estimatedCalls, estimated_cost_usd: estimateCost(spec) });
  }
  if (name === "run_benchmark") {
    const bench = await store.getBench(env, String(input.bench_id || ""));
    if (!bench) return JSON.stringify({ error: "benchmark not found" });
    const run = await runBenchmark(env, bench, {
      onProgress: (s) => emit({ t: "progress", s }),
      callCap: 30
    });
    await store.addRun(env, bench.id, run);
    emit({ t: "artifact", kind: "bench", id: bench.id });
    if (run.status !== "done") return JSON.stringify({ ok: false, status: run.status, errors: run.errors });
    return JSON.stringify({
      ok: true, run_id: run.id, totals: run.totals, wall_ms: run.wallMs,
      summary: summarizeRun(bench, run),
      variants: run.variants.map((v) => ({ id: v.id, label: v.label, model: v.model, pattern: v.pattern, effort: v.effort, metrics: v.metrics }))
    });
  }
  if (name === "queue_benchmark") {
    const bench = await store.getBench(env, String(input.bench_id || ""));
    if (!bench) return JSON.stringify({ error: "benchmark not found" });
    const n = await store.queuePush(env, bench.id);
    return JSON.stringify({ ok: true, queued: true, queue_length: n, note: "the nightly cron will run it (cap ~60 calls)" });
  }
  return JSON.stringify({ error: "unknown tool " + name });
}

// ── the streaming chat turn ──────────────────────────────────────────────────
export function chatStream(env, { thread, userText }) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        if (!thread.title || thread.title === "New thread") thread.title = userText.slice(0, 90);
        emit({ t: "meta", threadId: thread.id, title: thread.title });

        const [studies, benches] = await Promise.all([store.listStudies(env), store.listBenches(env)]);
        const system = systemPrompt(libraryDigest(studies, benches));

        const messages = [...thread.messages, { role: "user", content: userText }];
        const newMessages = [{ role: "user", content: userText }];

        for (let iter = 0; iter < 8; iter++) {
          const stream = client(env).messages.stream({
            model: CHAT_MODEL,
            max_tokens: 8000,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            system,
            tools: TOOLS,
            messages
          });

          for await (const event of stream) {
            if (event.type === "content_block_start") {
              const b = event.content_block;
              if (b.type === "tool_use" || b.type === "server_tool_use") {
                emit({ t: "tool", name: b.name, label: b.type === "server_tool_use" ? "searching" : "lab" });
              }
            } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              emit({ t: "delta", s: event.delta.text });
            }
          }

          const msg = await stream.finalMessage();
          const assistantMsg = { role: "assistant", content: msg.content };
          messages.push(assistantMsg);
          newMessages.push(assistantMsg);

          if (msg.stop_reason === "pause_turn") continue; // server tools resuming

          if (msg.stop_reason === "refusal") {
            emit({ t: "error", s: "The model declined this request (safety classifiers)." });
            break;
          }

          const toolUses = (msg.content || []).filter((b) => b.type === "tool_use");
          if (msg.stop_reason !== "tool_use" || !toolUses.length) break;

          const results = [];
          for (const tu of toolUses) {
            try {
              const out = await execTool(env, tu.name, tu.input || {}, emit);
              results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
            } catch (e) {
              results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: (e?.message || String(e)).slice(0, 400) });
              emit({ t: "error", s: `tool ${tu.name} failed: ${(e?.message || e)}`.slice(0, 200) });
            }
          }
          const resultMsg = { role: "user", content: results };
          messages.push(resultMsg);
          newMessages.push(resultMsg);
          emit({ t: "delta", s: "\n" });
        }

        thread.messages = [...thread.messages, ...newMessages];
        await store.saveThread(env, thread);
        emit({ t: "done" });
      } catch (err) {
        emit({ t: "error", s: (err?.message || String(err)).slice(0, 300) });
        try {
          thread.messages = [...thread.messages, { role: "user", content: userText }];
          await store.saveThread(env, thread);
        } catch {}
        emit({ t: "done" });
      } finally {
        controller.close();
      }
    }
  });
}
