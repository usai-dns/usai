// worker.js — intellistudy v2: a collaborative AI-architecture lab in one Worker.
//
//   fetch()
//     GET  /api/health              { ok, hasKey, kv, queue, counts }
//     GET  /api/state               sidebar indexes (threads/studies/benchmarks) — also
//                                   lazily migrates v1 research into a study once
//     GET  /api/threads             thread index          GET /api/thread/:id    full thread
//     POST /api/thread              create a thread
//     POST /api/chat                {threadId?, message} → NDJSON agent stream (the tool)
//     GET  /api/studies             study index           GET /api/study/:id     full study
//     GET  /api/benchmarks          bench index           GET /api/bench/:id     full bench + runs
//     POST /api/bench/run           {id} → NDJSON: progress lines + final measured run
//     POST /api/bench/queue         {id} → queued for the nightly cron
//     everything else               static assets (the chat workbench UI)
//
//   scheduled()                     drains the run queue (bigger call budget)
//
// Optional shared-secret gate: set the ACCESS_TOKEN secret and every /api/* route
// (except /api/health) requires the x-usai-key header (or ?key=). This matters
// because chat and runs spend YOUR Anthropic tokens.

import * as store from "./store.js";
import { runBenchmark, summarizeRun } from "./lab.js";
import { chatStream, chatStreamAlt, hasKey, CHAT_MODEL } from "./agent.js";
import { handleMcp } from "./mcp.js";
import { runWeeklyDigest } from "./tools.js";
import { listPods, reapExpired, hasRunpod } from "./pods.js";
import { availableDrivers, resolveDriver } from "./providers.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const ndjsonHeaders = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no"
};

function authorized(env, request, url) {
  if (!env.ACCESS_TOKEN) return true;
  const supplied = request.headers.get("x-usai-key") || url.searchParams.get("key") || "";
  return supplied === env.ACCESS_TOKEN;
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith("/api/") && pathname !== "/mcp") return env.ASSETS.fetch(request);

    if (pathname === "/api/health") {
      return json({
        ok: true,
        hasKey: hasKey(env),
        kv: Boolean(env.USAI_KV),
        model: CHAT_MODEL,
        drivers: availableDrivers(env),
        gated: Boolean(env.ACCESS_TOKEN),
        runpod: hasRunpod(env),
        queue: await store.queueLength(env)
      });
    }

    if (!authorized(env, request, url)) {
      return json({ error: "unauthorized", detail: "provide the shared key via the x-usai-key header (set as the ACCESS_TOKEN secret)" }, 401);
    }

    // ── MCP (directive §6): same tool surface as the chat, over streamable HTTP ──
    if (pathname === "/mcp") return handleMcp(request, env);

    // ── library state ──
    if (pathname === "/api/state") {
      await store.migrateV1(env);   // one-time: fold v1 findings/kaggle pull into a study
      await store.seedProblems(env); // one-time: P-001 per directive §5
      const [threads, studies, benches, queue, livePods] = await Promise.all([
        store.listThreads(env), store.listStudies(env), store.listBenches(env), store.queueLength(env), listPods(env)
      ]);
      return json({ threads, studies, benchmarks: benches, pods: livePods, queue, hasKey: hasKey(env), runpod: hasRunpod(env), model: CHAT_MODEL, drivers: availableDrivers(env) });
    }
    if (pathname === "/api/pods") return json(await listPods(env));
    if (pathname === "/api/problems") return json(await store.listProblems(env));

    // ── threads ──
    if (pathname === "/api/threads") return json(await store.listThreads(env));
    if (pathname.startsWith("/api/thread/")) {
      const t = await store.getThread(env, pathname.split("/").pop());
      return t ? json(t) : json({ error: "not found" }, 404);
    }
    if (pathname === "/api/thread" && request.method === "POST") {
      const body = await readBody(request);
      return json(await store.createThread(env, body.title));
    }

    // ── chat (the tool itself) ── body.driver picks the operating model (§7:
    // identity is logged per message); default is the Claude driver.
    if (pathname === "/api/chat" && request.method === "POST") {
      const body = await readBody(request);
      const message = (body.message || "").toString().trim();
      if (!message) return json({ error: "message required" }, 400);
      const d = resolveDriver(env, body.driver);
      if (d.error) return json({ error: "bad-driver", detail: d.error }, 400);
      let thread = body.threadId ? await store.getThread(env, String(body.threadId)) : null;
      if (!thread) thread = await store.createThread(env, message.slice(0, 90));
      const stream = d.provider === "anthropic"
        ? chatStream(env, { thread, userText: message })
        : chatStreamAlt(env, { thread, userText: message, provider: d.provider, model: d.model });
      return new Response(stream, { headers: ndjsonHeaders });
    }

    // ── studies ──
    if (pathname === "/api/studies") return json(await store.listStudies(env));
    if (pathname.startsWith("/api/study/")) {
      const s = await store.getStudy(env, pathname.split("/").pop());
      return s ? json(s) : json({ error: "not found" }, 404);
    }

    // ── benchmarks ──
    if (pathname === "/api/benchmarks") return json(await store.listBenches(env));
    if (pathname.startsWith("/api/bench/") && request.method === "GET") {
      const b = await store.getBench(env, pathname.split("/").pop());
      return b ? json(b) : json({ error: "not found" }, 404);
    }
    if (pathname === "/api/bench/queue" && request.method === "POST") {
      const body = await readBody(request);
      const bench = await store.getBench(env, String(body.id || ""));
      if (!bench) return json({ error: "not found" }, 404);
      const n = await store.queuePush(env, bench.id);
      return json({ ok: true, queue: n });
    }
    if (pathname === "/api/bench/run" && request.method === "POST") {
      if (!hasKey(env)) return json({ error: "no-key", detail: "Set the ANTHROPIC_API_KEY secret." }, 400);
      const body = await readBody(request);
      const bench = await store.getBench(env, String(body.id || ""));
      if (!bench) return json({ error: "not found" }, 404);
      // NDJSON stream: progress heartbeats keep the connection alive, then the run.
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
          try {
            emit({ t: "progress", s: `running "${bench.name}"…` });
            const run = await runBenchmark(env, bench, { onProgress: (s) => emit({ t: "progress", s }), callCap: 30 });
            await store.addRun(env, bench.id, run);
            emit({ t: "artifact", kind: "bench", id: bench.id });
            emit({ t: "run", run: { ...run, cells: undefined }, summary: summarizeRun(bench, run) });
          } catch (e) {
            emit({ t: "error", s: (e?.message || String(e)).slice(0, 300) });
          } finally {
            emit({ t: "done" });
            controller.close();
          }
        }
      });
      return new Response(stream, { headers: ndjsonHeaders });
    }

    return json({ error: "not found" }, 404);
  },

  // Hourly cron, three duties in order (scheduled invocations get ~15 minutes):
  //   1. reap pods past their TTL (money safety — a forgotten pod can't burn overnight)
  //   2. drain the benchmark run queue with the bigger budget
  //   3. Mondays 13:00 UTC: the weekly model/paper scan (directive §3), report-only
  async scheduled(controller, env, ctx) {
    for (const line of await reapExpired(env).catch(() => [])) console.log("[cron]", line);

    if (!hasKey(env)) { console.log("[cron] no ANTHROPIC_API_KEY — queue + digest skipped"); return; }

    for (let i = 0; i < 2; i++) {
      const item = await store.queuePop(env);
      if (!item) break;
      const bench = await store.getBench(env, item.benchId);
      if (!bench) { console.log(`[cron] bench ${item.benchId} missing`); continue; }
      try {
        const run = await runBenchmark(env, bench, { onProgress: (s) => console.log("[cron]", s), callCap: 60 });
        await store.addRun(env, bench.id, run);
        console.log("[cron]", summarizeRun(bench, run).split("\n")[0]);
      } catch (e) {
        console.log(`[cron] run of ${bench.id} failed:`, e?.message || e);
      }
    }

    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 13) {
      const r = await runWeeklyDigest(env).catch((e) => ({ ok: false, reason: String(e) }));
      console.log("[cron] weekly digest:", r.ok ? "filed" : r.reason);
    }
  }
};
