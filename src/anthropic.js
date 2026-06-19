// anthropic.js — the Claude integration for intellistudy.
//
// Two entry points:
//   runStudy(env, {...})   — one autonomous research pass (web_search/web_fetch),
//                            returns parsed {headline, summary, findings, scores}.
//   streamChat(env, {...}) — a streaming chat answer over the study corpus.
//
// Model + tool choices follow the current Anthropic API: claude-opus-4-8 with
// adaptive thinking, and the 2026-02 web tools with built-in dynamic filtering.
// Everything degrades gracefully when ANTHROPIC_API_KEY is unset so the app runs
// locally without a key (you just don't get live research/chat).

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-8";

// Server-side web tools (dynamic-filtering variants — supported on Opus 4.8).
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 6 };
const WEB_FETCH = { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 };

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export function hasKey(env) {
  return Boolean(env && env.ANTHROPIC_API_KEY);
}

function textOf(message) {
  return (message?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Pull the last fenced ```json block (the study schema) out of the reply.
function parseStudyJSON(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : null;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  // Best-effort: first balanced-looking object.
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

const STUDY_SYSTEM =
  "You are a rigorous AI-capability analyst. You search the web for primary sources, " +
  "synthesize what is new and what it means for deploying AI to self-manage work or engineer " +
  "solutions, and you always cite source URLs. You are honest about uncertainty and never invent " +
  "sources. You finish with the requested JSON block, exactly.";

// One research pass. Handles the server-tool pause_turn loop. Non-streaming
// (bounded max_tokens) so the scheduled handler stays simple.
export async function runStudy(env, { subjectId, task }) {
  if (!hasKey(env)) return { ok: false, reason: "no-key" };
  const anthropic = client(env);

  let messages = [{ role: "user", content: task }];
  let message = null;

  try {
    for (let i = 0; i < 8; i++) {
      message = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: STUDY_SYSTEM,
        tools: [WEB_SEARCH, WEB_FETCH],
        messages
      });
      // Server-side tool loop hit its iteration cap — re-send to resume.
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      break;
    }
  } catch (err) {
    return { ok: false, reason: "api-error", detail: err?.message || String(err) };
  }

  if (message?.stop_reason === "refusal") {
    return { ok: false, reason: "refusal" };
  }

  const text = textOf(message);
  const parsed = parseStudyJSON(text) || {};
  return {
    ok: true,
    headline: (parsed.headline || "").toString().slice(0, 200),
    summary: (parsed.summary || text).toString().slice(0, 2000),
    findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 8) : [],
    scores: parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {},
    usage: message?.usage || null
  };
}

// Streaming chat answer. Returns a ReadableStream of UTF-8 text deltas suitable
// for a text/plain streamed Response. web_search is always available; web_fetch
// is added when a link is provided to study.
export function streamChat(env, { system, messages, studyUrl }) {
  const anthropic = client(env);
  const tools = [WEB_SEARCH];
  if (studyUrl) tools.push(WEB_FETCH);

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system,
    tools,
    messages
  });

  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            controller.enqueue(enc.encode(event.delta.text));
          }
        }
      } catch (err) {
        controller.enqueue(enc.encode("\n\n⚠️ stream error: " + (err?.message || String(err))));
      } finally {
        controller.close();
      }
    }
  });
}
