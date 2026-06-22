// worker.js — intellistudy's Cloudflare Worker.
//
// It does two jobs:
//   fetch()     — serves the dashboard's static assets, plus a small API:
//                   GET  /data/state.json   merged canonical data (seed + live KV)
//                   GET  /api/state         same as above (alias)
//                   GET  /api/health        { ok, hasKey, lastRuns }
//                   POST /api/chat          streaming chat over the corpus
//                   POST /api/study/run     run + file a study now (manual trigger)
//   scheduled() — on the cron, studies the day's subject and writes a finding +
//                 updated benchmark scores into KV.
//
// The thin-shell contract is preserved: index.html is never edited. New data
// (studies, benchmark, findings) is merged into /data/state.json so existing and
// generated views render it; new visualizations ship as generated views/*.js.
//
// State persists in KV (binding USAI_KV). Live research/chat needs the secret
// ANTHROPIC_API_KEY; without it the dashboard + framework still render and the
// API returns clear setup guidance.

import {
  STUDY_PLAN,
  BENCHMARK,
  SEED_FINDINGS,
  subjectForDate,
  subjectName,
  studyTask,
  chatSystem,
  buildDigest
} from "./studies.js";
import { runStudy, streamChat, hasKey, MODEL } from "./anthropic.js";

const FINDINGS_KEY = "findings";
const SCORES_KEY = "scores";
const LASTRUNS_KEY = "lastRuns";
const MAX_FINDINGS = 200;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

// ── KV helpers (all guard a missing binding so dev/preview never hard-fails) ──
async function kvGet(env, key, fallback) {
  if (!env.USAI_KV) return fallback;
  try {
    const v = await env.USAI_KV.get(key, "json");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
async function kvPut(env, key, value) {
  if (!env.USAI_KV) return;
  try {
    await env.USAI_KV.put(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

// Overlay live KV scores on top of the seed scores.
function mergeScores(liveScores) {
  const merged = JSON.parse(JSON.stringify(BENCHMARK.seedScores));
  for (const [subject, axes] of Object.entries(liveScores || {})) {
    merged[subject] = merged[subject] || {};
    for (const [axis, val] of Object.entries(axes || {})) {
      merged[subject][axis] = { ...val, seed: false };
    }
  }
  return merged;
}

// Fetch the static seed (experiments/results/discoveries/resources) via the
// assets binding, then merge in the study framework + live KV data.
async function buildState(env, request) {
  let base = {};
  try {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/seed.json", request.url)));
    if (res.ok) base = await res.json();
  } catch {
    /* seed missing — render framework only */
  }

  const [liveScores, liveFindings, lastRuns] = await Promise.all([
    kvGet(env, SCORES_KEY, {}),
    kvGet(env, FINDINGS_KEY, []),
    kvGet(env, LASTRUNS_KEY, {})
  ]);

  const findings = [...liveFindings, ...SEED_FINDINGS];

  return {
    ...base,
    studies: STUDY_PLAN,
    benchmark: {
      axes: BENCHMARK.axes,
      subjects: BENCHMARK.subjects,
      scale: BENCHMARK.scale,
      scores: mergeScores(liveScores)
    },
    findings,
    meta: {
      generated: new Date().toISOString(),
      hasKey: hasKey(env),
      mode: env.USAI_KV ? "live" : "ephemeral",
      lastRuns,
      model: MODEL
    }
  };
}

// Run a study pass and persist the finding + score updates.
async function runAndPersist(env, { subjectId, url, question, trigger, effort }) {
  const task = studyTask(subjectId, { url, question });
  const result = await runStudy(env, { subjectId, task, effort });
  if (!result.ok) return result;

  const finding = {
    id: crypto.randomUUID(),
    subject: subjectId,
    subjectName: subjectName(subjectId),
    ts: new Date().toISOString(),
    headline: result.headline || result.summary.slice(0, 100),
    summary: result.summary,
    points: (result.findings || []).map((f) => ({
      text: (f.text || "").toString(),
      url: (f.url || "").toString()
    })),
    model: MODEL,
    trigger: trigger || "manual"
  };

  // Append finding (newest first, capped).
  const findings = await kvGet(env, FINDINGS_KEY, []);
  findings.unshift(finding);
  await kvPut(env, FINDINGS_KEY, findings.slice(0, MAX_FINDINGS));

  // Update scores for this subject (synthesis returns none).
  if (result.scores && Object.keys(result.scores).length && subjectId !== "synthesis") {
    const scores = await kvGet(env, SCORES_KEY, {});
    scores[subjectId] = scores[subjectId] || {};
    for (const [axis, val] of Object.entries(result.scores)) {
      const score = typeof val === "object" ? val.score : val;
      const note = typeof val === "object" ? val.note || "" : "";
      if (typeof score === "number") {
        scores[subjectId][axis] = {
          score,
          note,
          source: (finding.points[0] && finding.points[0].url) || null,
          ts: finding.ts
        };
      }
    }
    await kvPut(env, SCORES_KEY, scores);
  }

  // Record last-run time.
  const lastRuns = await kvGet(env, LASTRUNS_KEY, {});
  lastRuns[subjectId] = finding.ts;
  await kvPut(env, LASTRUNS_KEY, lastRuns);

  return { ok: true, finding };
}

// ───────────────────────────── HTTP handlers ─────────────────────────────────
async function handleChat(env, request) {
  const noKey = !hasKey(env);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return json({ error: "messages[] required" }, 400);

  if (noKey) {
    return new Response(
      "⚠️ Chat is not configured yet.\n\nSet the ANTHROPIC_API_KEY secret to enable the " +
        "Claude-powered chat and autonomous study:\n  • local: put ANTHROPIC_API_KEY=sk-... in .dev.vars\n" +
        "  • cloud: npx wrangler secret put ANTHROPIC_API_KEY\n\nThe dashboard, study plan, and " +
        "benchmark framework work without a key — only live research and chat need it.",
      { headers: { "content-type": "text/plain; charset=utf-8", "x-usai-status": "no-key" } }
    );
  }

  // Give the assistant the current corpus as context.
  const state = await buildState(env, request);
  const system = chatSystem(buildDigest(state));

  // If a link was supplied, make sure it's in the conversation for web_fetch.
  const studyUrl = typeof body.studyUrl === "string" && body.studyUrl.trim() ? body.studyUrl.trim() : null;
  if (studyUrl) {
    const last = messages[messages.length - 1];
    if (last && last.role === "user") {
      const txt = typeof last.content === "string" ? last.content : "";
      last.content = `${txt}\n\n[Study this link with web_fetch: ${studyUrl}]`;
    }
  }

  const stream = streamChat(env, { system, messages, studyUrl });
  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-usai-status": "ok" }
  });
}

// On-demand study. A full research pass can take a minute or two — longer than a
// synchronous HTTP response should hold — so we kick it off in the background
// (ctx.waitUntil keeps the Worker alive past the response) and return 202
// immediately. The client polls /data/state.json for the new finding.
async function handleStudyRun(env, request, ctx) {
  if (!hasKey(env)) return json({ error: "no-key", detail: "Set ANTHROPIC_API_KEY to run studies." }, 400);
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const subjectId = (body.subject && String(body.subject)) || subjectForDate();
  const subj = subjectId === "idle" ? "claude-code-cloud" : subjectId; // never study 'idle'

  ctx.waitUntil(
    runAndPersist(env, {
      subjectId: subj,
      url: body.url ? String(body.url) : undefined,
      question: body.question ? String(body.question) : undefined,
      trigger: "manual",
      effort: "medium"
    })
      .then((r) => console.log(`[study/run] ${subj}:`, r.ok ? "filed" : r.reason, r.detail || ""))
      .catch((e) => console.log(`[study/run] ${subj} error:`, e?.message || e))
  );

  return json({ status: "running", subject: subj, note: "Filing in the background; poll /data/state.json for the new finding (~1-2 min)." }, 202);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/data/state.json" || pathname === "/api/state") {
      return json(await buildState(env, request));
    }
    if (pathname === "/api/health") {
      return json({
        ok: true,
        hasKey: hasKey(env),
        model: MODEL,
        kv: Boolean(env.USAI_KV),
        lastRuns: await kvGet(env, LASTRUNS_KEY, {}),
        todaysSubject: subjectForDate()
      });
    }
    if (pathname === "/api/chat" && request.method === "POST") {
      return handleChat(env, request);
    }
    if (pathname === "/api/study/run" && request.method === "POST") {
      return handleStudyRun(env, request, ctx);
    }

    // Everything else is a static asset (the shell, views, seed.json, …).
    return env.ASSETS.fetch(request);
  },

  // Cron: study the day's subject and file the result.
  async scheduled(controller, env, ctx) {
    const subjectId = subjectForDate(new Date());
    if (subjectId === "idle") return; // Sunday — rest
    if (!hasKey(env)) {
      console.log("[scheduled] skipped: ANTHROPIC_API_KEY not set");
      return;
    }
    ctx.waitUntil(
      runAndPersist(env, { subjectId, trigger: "scheduled", effort: "high" })
        .then((r) => console.log(`[scheduled] ${subjectId}:`, r.ok ? "filed" : r.reason))
        .catch((e) => console.log(`[scheduled] ${subjectId} error:`, e?.message || e))
    );
  }
};
