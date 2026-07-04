// store.js — the KV data layer for intellistudy v2.
//
// Three first-class, durable artifact types (the collaborative substrate):
//   studies     — research documents: notes with sources, grown by chat/links/research
//   benchmarks  — experiment specs + their run history (real measured results)
//   threads     — saved chat conversations (full fidelity, trimmed at the tail)
// plus a run queue the cron drains for large benchmark runs.
//
// Index keys hold compact listings for the sidebar; full objects live per-id.
// All helpers guard a missing KV binding so dev/preview never hard-fails.

const IDX_STUDIES = "idx:studies";
const IDX_BENCHES = "idx:benchmarks";
const IDX_THREADS = "idx:threads";
const RUN_QUEUE = "runqueue";
const MIGRATED = "migrated:v1";

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

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
  await env.USAI_KV.put(key, JSON.stringify(value));
}

// ── studies ──────────────────────────────────────────────────────────────────
export async function listStudies(env) {
  return kvGet(env, IDX_STUDIES, []);
}
export async function getStudy(env, id) {
  return kvGet(env, "study:" + id, null);
}
export async function saveStudy(env, study) {
  study.updated = new Date().toISOString();
  await kvPut(env, "study:" + study.id, study);
  const idx = (await listStudies(env)).filter((s) => s.id !== study.id);
  idx.unshift({ id: study.id, title: study.title, updated: study.updated, notes: study.notes.length });
  await kvPut(env, IDX_STUDIES, idx.slice(0, 200));
  return study;
}
export async function createStudy(env, title) {
  const study = {
    id: newId(),
    title: (title || "Untitled study").slice(0, 120),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    notes: []
  };
  return saveStudy(env, study);
}
// Append a note; creates the study when study_id is absent.
export async function addNote(env, { studyId, studyTitle, title, content, sources, origin }) {
  let study = studyId ? await getStudy(env, studyId) : null;
  if (!study) study = await createStudy(env, studyTitle || title);
  study.notes.unshift({
    id: newId(),
    ts: new Date().toISOString(),
    title: (title || "note").slice(0, 160),
    content: (content || "").slice(0, 8000),
    sources: (sources || []).map(String).slice(0, 12),
    origin: origin || "chat"
  });
  study.notes = study.notes.slice(0, 100);
  await saveStudy(env, study);
  return study;
}

// ── benchmarks ───────────────────────────────────────────────────────────────
export async function listBenches(env) {
  return kvGet(env, IDX_BENCHES, []);
}
export async function getBench(env, id) {
  return kvGet(env, "bench:" + id, null);
}
export async function saveBench(env, bench) {
  bench.version = bench.version || 1; // normalize pre-versioning benches
  bench.updated = new Date().toISOString();
  await kvPut(env, "bench:" + bench.id, bench);
  const last = bench.runs && bench.runs[0];
  const idx = (await listBenches(env)).filter((b) => b.id !== bench.id);
  idx.unshift({
    id: bench.id,
    name: bench.name,
    updated: bench.updated,
    runs: (bench.runs || []).length,
    lastStatus: last ? last.status : "never-run"
  });
  await kvPut(env, IDX_BENCHES, idx.slice(0, 200));
  return bench;
}
export async function createBench(env, { name, hypothesis, spec, version = 1, parentId = null }) {
  const bench = {
    id: newId(),
    name: (name || "Untitled benchmark").slice(0, 120),
    hypothesis: (hypothesis || "").slice(0, 500),
    spec,
    version,
    parentId,
    frozen: false, // R2: flips true on first run; specs never mutate after that
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    runs: []
  };
  return saveBench(env, bench);
}
// R2: amendments never touch a frozen version — they create vN+1 with a parent link.
export async function amendBench(env, parentBenchId, { spec, hypothesis, name }) {
  const parent = await getBench(env, parentBenchId);
  if (!parent) return null;
  return createBench(env, {
    name: name || parent.name,
    hypothesis: hypothesis ?? parent.hypothesis,
    spec: spec || parent.spec,
    version: (parent.version || 1) + 1,
    parentId: parent.id
  });
}
export async function addRun(env, benchId, run) {
  const bench = await getBench(env, benchId);
  if (!bench) return null;
  bench.frozen = true; // R2: first run freezes the spec forever
  bench.runs.unshift(run);
  bench.runs = bench.runs.slice(0, 20); // keep run history bounded
  // run_id → bench_id map so reports can be pulled by either id
  if (env.USAI_KV && run.id) await kvPut(env, "run:" + run.id, { benchId });
  return saveBench(env, bench);
}
export async function benchIdForRun(env, runId) {
  const m = await kvGet(env, "run:" + runId, null);
  return m ? m.benchId : null;
}

// ── threads (saved chats) ────────────────────────────────────────────────────
export async function listThreads(env) {
  return kvGet(env, IDX_THREADS, []);
}
export async function getThread(env, id) {
  return kvGet(env, "thread:" + id, null);
}
export async function createThread(env, title) {
  const thread = {
    id: newId(),
    title: (title || "New thread").slice(0, 90),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    messages: []
  };
  await saveThread(env, thread);
  return thread;
}
export async function saveThread(env, thread) {
  thread.updated = new Date().toISOString();
  thread.messages = trimMessages(thread.messages);
  await kvPut(env, "thread:" + thread.id, thread);
  const idx = (await listThreads(env)).filter((t) => t.id !== thread.id);
  idx.unshift({ id: thread.id, title: thread.title, updated: thread.updated, messages: thread.messages.length });
  await kvPut(env, IDX_THREADS, idx.slice(0, 100));
  return thread;
}

// Trim long threads without orphaning tool_use/tool_result pairs: keep the tail,
// but always start at a plain user text message.
export function trimMessages(messages, max = 40) {
  if (!Array.isArray(messages) || messages.length <= max) return messages || [];
  const tail = messages.slice(-max);
  let start = tail.findIndex((m) => m.role === "user" && typeof m.content === "string");
  if (start === -1) {
    // fall back: first user message whose content has no tool_result blocks
    start = tail.findIndex(
      (m) => m.role === "user" && (!Array.isArray(m.content) || !m.content.some((b) => b && b.type === "tool_result"))
    );
  }
  return start > 0 ? tail.slice(start) : tail;
}

// ── problems (directive §5 intake) ───────────────────────────────────────────
const IDX_PROBLEMS = "idx:problems";
export const PROBLEM_CLASSES = ["extraction", "drafting", "classification", "conversation", "routing"];

export async function listProblems(env) {
  return kvGet(env, IDX_PROBLEMS, []);
}
export async function submitProblem(env, p) {
  const problems = await listProblems(env);
  const id = p.problem_id || "P-" + String(problems.length + 1).padStart(3, "0");
  const entry = {
    problem_id: id,
    name: String(p.name || "unnamed").slice(0, 120),
    problem_class: PROBLEM_CLASSES.includes(p.problem_class) ? p.problem_class : "extraction",
    description: String(p.description || "").slice(0, 2000),
    input_spec: String(p.input_spec || "").slice(0, 1000),
    gold_output_spec: String(p.gold_output_spec || "").slice(0, 1000),
    latency_tolerance: ["batch", "interactive", "realtime-voice"].includes(p.latency_tolerance) ? p.latency_tolerance : "batch",
    data_sensitivity: ["public", "client", "borrower-PII"].includes(p.data_sensitivity) ? p.data_sensitivity : "client",
    volume_estimate: String(p.volume_estimate || "").slice(0, 200),
    current_solution: String(p.current_solution || "").slice(0, 300),
    gold_set_status: String(p.gold_set_status || "none").slice(0, 60),
    ts: new Date().toISOString()
  };
  const idx = problems.filter((x) => x.problem_id !== entry.problem_id);
  idx.unshift(entry);
  await kvPut(env, IDX_PROBLEMS, idx.slice(0, 100));
  return entry;
}
// Seed P-001 (directive §5, committed) exactly once.
export async function seedProblems(env) {
  if (!env.USAI_KV) return;
  if (await kvGet(env, "seed:problems", false)) return;
  const existing = await listProblems(env);
  if (!existing.some((p) => p.problem_id === "P-001")) {
    await submitProblem(env, {
      problem_id: "P-001",
      name: "Post-call transcript parsing / qualification extraction",
      problem_class: "extraction",
      description: "Parse call transcripts into structured qualification fields. Becomes authored benchmark FF-EXTRACT v1.0 (50 transcripts, 40 dev / 10 holdout, field-level F1 + schema validity + exact-match on critical fields).",
      input_spec: "call transcript (text)",
      gold_output_spec: "structured qualification JSON (field schema TBD with gold set)",
      latency_tolerance: "batch",
      data_sensitivity: "borrower-PII",
      volume_estimate: "TBD",
      current_solution: "frontier API model in production",
      gold_set_status: "blocked: awaiting 50 transcripts with gold outputs from Dennis"
    });
  }
  await kvPut(env, "seed:problems", true);
}

// ── run queue (cron-processed) ───────────────────────────────────────────────
export async function queuePush(env, benchId) {
  const q = await kvGet(env, RUN_QUEUE, []);
  if (!q.some((e) => e.benchId === benchId)) q.push({ benchId, ts: new Date().toISOString() });
  await kvPut(env, RUN_QUEUE, q.slice(0, 20));
  return q.length;
}
export async function queuePop(env) {
  const q = await kvGet(env, RUN_QUEUE, []);
  const item = q.shift() || null;
  await kvPut(env, RUN_QUEUE, q);
  return item;
}
export async function queueLength(env) {
  return (await kvGet(env, RUN_QUEUE, [])).length;
}

// ── v1 migration ─────────────────────────────────────────────────────────────
// Fold the v1 research (findings + kaggle leaderboard pull) into a study so
// nothing already gathered is lost. Runs once, lazily.
export async function migrateV1(env) {
  if (!env.USAI_KV) return false;
  if (await kvGet(env, MIGRATED, false)) return false;
  const findings = await kvGet(env, "findings", []);
  const kaggle = await kvGet(env, "kaggle", null);
  if (!findings.length && !kaggle) {
    await kvPut(env, MIGRATED, true);
    return false;
  }
  let study = await createStudy(env, "Imported v1 research");
  for (const f of [...findings].reverse()) {
    const body =
      (f.summary || "") +
      "\n\n" +
      (f.points || []).map((p) => `- ${p.text}${p.url ? ` (${p.url})` : ""}`).join("\n");
    study.notes.unshift({
      id: newId(),
      ts: f.ts || new Date().toISOString(),
      title: `[${f.subjectName || f.subject}] ${f.headline || "finding"}`.slice(0, 160),
      content: body.slice(0, 8000),
      sources: (f.points || []).map((p) => p.url).filter(Boolean).slice(0, 12),
      origin: "v1-import"
    });
  }
  if (kaggle && Array.isArray(kaggle.leaderboard)) {
    study.notes.unshift({
      id: newId(),
      ts: kaggle.updated || new Date().toISOString(),
      title: "Kaggle Benchmarks leaderboard pull",
      content: kaggle.leaderboard.map((r, i) => `${i + 1}. ${r.model} — ${r.score}${r.benchmark ? ` [${r.benchmark}]` : ""}`).join("\n"),
      sources: [kaggle.source, "https://www.kaggle.com/benchmarks"].filter(Boolean),
      origin: "v1-import"
    });
  }
  await saveStudy(env, study);
  await kvPut(env, MIGRATED, true);
  return true;
}
