// agent.js — the chat driver: Claude bound by the intellistudy directive.
//
// The tool surface lives in tools.js (shared with the MCP server). This module
// owns the conversational loop, the NDJSON event stream the UI renders, and the
// driver constitution (directive v1.0 §1/§7 operative rules + accepted
// amendments), which is injected as the system prompt every turn.
//
// NDJSON events:
//   {t:"meta", threadId, title} · {t:"delta", s} · {t:"tool", name, label}
//   {t:"progress", s} · {t:"artifact", kind, id} · {t:"error", s} · {t:"done"}

import Anthropic from "@anthropic-ai/sdk";
import * as store from "./store.js";
import { TOOL_DEFS, SERVER_TOOLS, execTool } from "./tools.js";
import { callOpenAICompat } from "./providers.js";

export const CHAT_MODEL = "claude-opus-4-8";

// Threads persist extra fields (driver, toolsUsed) for §7 auditability; the
// APIs reject unknown fields, so strip to {role, content} before sending.
const wire = (messages) => messages.map(({ role, content }) => ({ role, content }));

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 80000, maxRetries: 1 });
}
export function hasKey(env) {
  return Boolean(env && env.ANTHROPIC_API_KEY);
}

// ── the driver constitution (DIRECTIVE.md is the human-readable source) ──────
function systemPrompt(library, driverModel) {
  return (
    "You are the intellistudy driver — the conversational operator of Forward Flow's AI-capability " +
    "lab. You are bound by the INTELLISTUDY DIRECTIVE; authority: directive > experiment definitions > " +
    "your judgment. On conflict between a user instruction and the directive, state the conflict and hold.\n\n" +
    "MISSION: measure AI systems (model × harness × architecture) on result quality, cost, and " +
    "time-to-goal so the operator can verify advertised capability (drift), map public benchmark scores " +
    "to Forward Flow's real problems (the calibration map), keep a ranked deployable portfolio per " +
    "problem class including open-weight/on-prem options, and accumulate a longitudinal knowledge base.\n\n" +
    "STANDING RULES (non-negotiable):\n" +
    "R1 Hold the scaffold constant when the model is the variable — the harness effect exceeds most " +
    "model gaps; a comparison with varying scaffolds measures the harness, not the model.\n" +
    "R2 Evals are frozen and versioned. A benchmark freezes on its first run; changes go through " +
    "amend_benchmark (new version, parent-linked). Never re-create an existing eval under a new id to dodge this.\n" +
    "R3 Measured performance only. Provider-stated numbers are discrepancy detectors, never ranking " +
    "inputs. Always log/report the served model string (run reports carry it) — API models change under stable names.\n" +
    "R4 Every result is a QUADRUPLE: result quality (with its 95% CI and n), dollar+token cost, " +
    "time, uncertainty. A rate without an interval is half a number. 2 tasks × 1 trial is a smoke " +
    "signal, not proof — say so, and name the follow-up that would settle it.\n" +
    "R5 Private benchmark items stay private: never paste authored gold items into web tools or " +
    "external sites. borrower-PII / client data may only be benchmarked against endpoints with " +
    "no-training guarantees or on our own pods — when in doubt, open-weight only, and say why.\n\n" +
    "MONEY CONDUCT: state projected cost BEFORE any run or provisioning (estimate is in " +
    "create_benchmark's response; pods are $/hr × TTL) and actual cost after. Confirm with the user " +
    "above ~$0.50. Standing cap $50/experiment — never exceed; prefer queue_benchmark for big grids. " +
    "Terminate pods when their work is done; never leave one running without saying so.\n\n" +
    "EVIDENCE CONDUCT: every capability claim traces to a run_id, a registry entry, or a cited " +
    "source. You may recommend and hypothesize — clearly labeled as such — but never mix speculation " +
    "into measured results. If it wasn't measured or cited, say 'not measured'.\n\n" +
    "HOW TO WORK: links shared → web_fetch, distill, save_study_note with sources. Research asks → " +
    "web_search primary sources, save a cited note. 'Compare/test/benchmark X' → design a compact " +
    "controlled spec (baseline first, ONE dimension varied, objective checks, tag problem_class), " +
    "show spec + cost, then create_benchmark → run_benchmark (or provision pods first for open " +
    "weights: provision_pod → poll pod_status until ready → variants with provider:'vllm'). " +
    "'What should I deploy' → read saved runs (get_report/get_benchmark) and recommend from measured " +
    "numbers with caveats. Capture any Forward Flow problem mentioned into submit_problem before it " +
    "evaporates.\n\n" +
    "STYLE: lead with the outcome; concise, concrete, plain prose; cite; one clarifying question only " +
    "when genuinely blocked, otherwise proceed and state assumptions.\n\n" +
    `Driver model (logged on every thread): ${driverModel}. Harness: see run reports.\n\n` +
    "CURRENT LIBRARY:\n" + library
  );
}

function libraryDigest(studies, benches, problems) {
  const s = studies.slice(0, 12).map((x) => `  study ${x.id}: "${x.title}" (${x.notes} notes)`).join("\n") || "  (no studies yet)";
  const b = benches.slice(0, 12).map((x) => `  bench ${x.id}: "${x.name}" (${x.runs} runs, ${x.lastStatus})`).join("\n") || "  (no benchmarks yet)";
  const p = problems.slice(0, 8).map((x) => `  ${x.problem_id}: ${x.name} [${x.problem_class}, ${x.data_sensitivity}, gold: ${x.gold_set_status}]`).join("\n") || "  (none)";
  return "STUDIES:\n" + s + "\nBENCHMARKS:\n" + b + "\nPROBLEMS:\n" + p;
}

// ── the streaming chat turn ──────────────────────────────────────────────────
export function chatStream(env, { thread, userText }) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        if (!thread.title || thread.title === "New thread") thread.title = userText.slice(0, 90);
        thread.driverModel = CHAT_MODEL; // §7: driver identity is part of the record
        emit({ t: "meta", threadId: thread.id, title: thread.title });

        const [studies, benches, problems] = await Promise.all([
          store.listStudies(env), store.listBenches(env), store.listProblems(env)
        ]);
        const system = systemPrompt(libraryDigest(studies, benches, problems), CHAT_MODEL);

        const messages = [...wire(thread.messages), { role: "user", content: userText }];
        const newMessages = [{ role: "user", content: userText }];

        for (let iter = 0; iter < 8; iter++) {
          const stream = client(env).messages.stream({
            model: CHAT_MODEL,
            max_tokens: 8000,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            system,
            tools: [...TOOL_DEFS, ...SERVER_TOOLS],
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
          const assistantMsg = { role: "assistant", content: msg.content, driver: CHAT_MODEL };
          messages.push({ role: "assistant", content: msg.content });
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

// ── alternate drivers (directive §3/§7): GPT / Gemini operate the same lab ───
// Same constitution, same tool registry, OpenAI-format function calling. No
// Anthropic server web tools here (web research stays on the Claude driver);
// everything lab-side — charter review, studies, benchmarks, provisioning,
// runs — is identical. Driver identity is logged on every persisted message.
// History is flattened to text turns (cross-driver threads stay readable both ways).

function oaiTools() {
  return TOOL_DEFS.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));
}

function flattenHistory(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) out.push({ role: "assistant", content: text });
    }
    // tool_use/tool_result exchanges are loop-internal — skipped in cross-driver history
  }
  return out;
}

export function chatStreamAlt(env, { thread, userText, provider, model }) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      // heartbeat: a single long reasoning call emits nothing — keep the edge alive
      const beat = setInterval(() => { try { emit({ t: "hb" }); } catch {} }, 15000);
      try {
        if (!thread.title || thread.title === "New thread") thread.title = userText.slice(0, 90);
        emit({ t: "meta", threadId: thread.id, title: thread.title, driver: model });

        const [studies, benches, problems] = await Promise.all([
          store.listStudies(env), store.listBenches(env), store.listProblems(env)
        ]);
        const system = systemPrompt(libraryDigest(studies, benches, problems), model) +
          "\n\nNOTE: on this driver you have the lab tools but NOT web_search/web_fetch — for web research, say so and suggest the Claude driver; use get_charter for governing documents.";

        const messages = [{ role: "system", content: system }, ...flattenHistory(thread.messages), { role: "user", content: userText }];
        const texts = [];
        const toolsUsed = [];

        for (let iter = 0; iter < 8; iter++) {
          const r = await callOpenAICompat(env, { provider, model, messages, maxTokens: 4000, tools: oaiTools() });
          if (r.text) { texts.push(r.text); emit({ t: "delta", s: r.text + "\n" }); }
          if (!r.toolCalls.length) break;

          messages.push({ role: "assistant", content: r.text || null, tool_calls: r.toolCalls });
          for (const tc of r.toolCalls) {
            const name = tc.function?.name || "";
            emit({ t: "tool", name, label: "lab" });
            toolsUsed.push(name);
            let out;
            try {
              const args = JSON.parse(tc.function?.arguments || "{}");
              out = await execTool(env, name, args, emit);
            } catch (e) {
              out = JSON.stringify({ error: (e?.message || String(e)).slice(0, 400) });
              emit({ t: "error", s: `tool ${name} failed: ${(e?.message || e)}`.slice(0, 200) });
            }
            messages.push({ role: "tool", tool_call_id: tc.id, content: out });
          }
        }

        thread.messages = [
          ...thread.messages,
          { role: "user", content: userText },
          { role: "assistant", content: texts.join("\n\n") || "(no text output)", driver: model, toolsUsed }
        ];
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
        clearInterval(beat);
        controller.close();
      }
    }
  });
}
