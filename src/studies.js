// studies.js — the canonical study framework for intellistudy.
//
// This is the single source of truth for WHAT the worker studies and HOW it is
// scored. It is deliberately data, not behaviour: the worker (worker.js) reads
// these definitions, runs scheduled web research against them, and writes live
// findings + benchmark scores into KV. The dashboard renders the merged result.
//
// Three things live here:
//   1. STUDY_PLAN  — the regimen: cadence, weekly schedule, and the study tracks.
//   2. BENCHMARK   — the commercial benchmark: subjects × axes rubric + seed scores.
//   3. helpers     — pick today's subject, build a study task, digest the corpus.
//
// To add a study track or a benchmark axis, edit the arrays below — nothing else
// needs to change. The scheduled worker will pick it up on its next run.

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE REGIMEN
// ─────────────────────────────────────────────────────────────────────────────

// weekday (UTC, 0=Sun..6=Sat) -> subject id studied that day.
// One subject per weekday; Saturday is a cross-cutting synthesis; Sunday idles.
export const SCHEDULE = {
  1: "claude-code-cloud", // Mon
  2: "claude-cli",        // Tue
  3: "claude-tools",      // Wed
  4: "open-source",       // Thu
  5: "research",          // Fri
  6: "synthesis",         // Sat — cross-cutting weekly synthesis
  0: "idle",              // Sun — no run
};

const DAY_LABEL = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

// The study tracks. Each is a subject the worker studies and scores. `seedSources`
// are starting points; the worker is free to search beyond them.
export const TRACKS = [
  {
    id: "claude-code-cloud",
    name: "Claude Code — Cloud",
    group: "claude",
    goal: "Track Claude Code running in the cloud (web, remote sandboxes, GitHub Actions): autonomy, scheduling, parallel sessions, isolation, and the deploy story.",
    why: "This is the surface you are running on now — the cleanest path to fleets of self-managing agents working asynchronously on your stack.",
    seedSources: [
      "https://code.claude.com/docs/en/claude-code-on-the-web",
      "https://www.anthropic.com/news",
      "https://platform.claude.com/docs/en/managed-agents/overview"
    ],
    questions: [
      "What can a cloud session do unattended end-to-end, and where does it still need a human?",
      "How do scheduling, triggers, and parallel sessions work, and what do they cost?",
      "What is the isolation / security model for the ephemeral environment?"
    ]
  },
  {
    id: "claude-cli",
    name: "Claude CLI (Claude Code)",
    group: "claude",
    goal: "Track the local Claude Code CLI: hooks, slash commands, subagents, MCP wiring, settings, headless/SDK mode, and effort/thinking controls.",
    why: "The CLI is the highest-leverage way to put Claude directly on your machine and in your pipelines with full local context.",
    seedSources: [
      "https://code.claude.com/docs",
      "https://code.claude.com/docs/en/headless",
      "https://www.anthropic.com/engineering"
    ],
    questions: [
      "Which CLI primitives (hooks, subagents, skills) most increase autonomy per token?",
      "How do you wire the CLI into CI and headless automation reliably?",
      "What effort/thinking settings give the best cost-of-pass for coding work?"
    ]
  },
  {
    id: "claude-tools",
    name: "Claude + Tools & Systems",
    group: "claude",
    goal: "Track Claude driving external systems: MCP servers, tool use, the Agent SDK, computer use, and Managed Agents — i.e. Claude as the brain over your stack.",
    why: "Solving problems in your stack and shipping products means Claude must reliably operate real tools and services, not just write text.",
    seedSources: [
      "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
      "https://modelcontextprotocol.io",
      "https://platform.claude.com/docs/en/managed-agents/overview"
    ],
    questions: [
      "Which tool-use patterns (MCP, programmatic tool calling, computer use) are production-ready vs experimental?",
      "What is the reliability ceiling when Claude orchestrates multiple systems?",
      "Where do MCP / Agent SDK integrations break, and how are people hardening them?"
    ]
  },
  {
    id: "open-source",
    name: "Open Source",
    group: "field",
    goal: "Track open-weight models and open agent frameworks (e.g. open coding models, OpenHands/Aider-style harnesses): capability, cost, and self-hostability.",
    why: "Open models set the cost floor and the self-host option — the fallback and the cost benchmark for everything you deploy.",
    seedSources: [
      "https://huggingface.co/models",
      "https://github.com/All-Hands-AI/OpenHands",
      "https://www.swebench.com"
    ],
    questions: [
      "Which open-weight models are closing the gap on agentic coding, and at what cost?",
      "Which open agent harnesses are worth running, and how do they compare to Claude Code?",
      "What can actually be self-hosted today for an autonomous coding loop?"
    ]
  },
  {
    id: "research",
    name: "Research & Evals",
    group: "field",
    goal: "Track frontier research and evaluation methodology: agent papers, new benchmarks (SWE-bench & successors), eval design, and inference-time techniques.",
    why: "Research is the leading indicator — it tells you what your stack will be able to do in 3–6 months and how to measure it honestly.",
    seedSources: [
      "https://arxiv.org/list/cs.AI/recent",
      "https://www.swebench.com",
      "https://www.anthropic.com/research"
    ],
    questions: [
      "What new techniques materially move agentic capability or cost-of-pass?",
      "Which benchmarks are credible, and which are saturated or gameable?",
      "What does the research say about harness design and process supervision?"
    ]
  }
];

export const STUDY_PLAN = {
  cadence:
    "One subject is studied per weekday (UTC) via an autonomous web_search pass; Saturday runs a cross-cutting synthesis; Sunday idles. Each run appends a sourced finding and updates that subject's benchmark scores. Change the cadence in wrangler.toml ([triggers].crons) and the day→subject map in src/studies.js (SCHEDULE).",
  cron: "0 13 * * *",
  schedule: Object.entries(SCHEDULE).map(([day, subject]) => ({
    day: DAY_LABEL[day],
    dow: Number(day),
    subject
  })).sort((a, b) => (a.dow === 0 ? 7 : a.dow) - (b.dow === 0 ? 7 : b.dow)),
  tracks: TRACKS.map(({ id, name, group, goal, why, seedSources, questions }) => ({
    id, name, group, goal, why, seedSources, questions
  }))
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE COMMERCIAL BENCHMARK
// ─────────────────────────────────────────────────────────────────────────────

// The axes every subject is scored on. Vocabulary intentionally extends the
// project's existing terms (cost-of-pass, convergence-vs-thrash).
export const AXES = [
  { id: "autonomy",        name: "Autonomy",         desc: "How much it does unattended end-to-end (multi-step, scheduled, self-correcting)." },
  { id: "tool_breadth",    name: "Tool breadth",     desc: "Range of tools / systems it can drive (files, shells, APIs, MCP, browsers)." },
  { id: "convergence",     name: "Convergence",      desc: "Reliability of reaching a correct end state vs thrashing." },
  { id: "cost_of_pass",    name: "Cost-of-pass",     desc: "Economic efficiency per successful task. Higher = cheaper success." },
  { id: "context_scale",   name: "Context / scale",  desc: "Context window and ability to handle repo- and project-scale work." },
  { id: "deploy_friction", name: "Deployability",    desc: "Ease of putting into production in your stack. Higher = lower friction." },
  { id: "ecosystem",       name: "Ecosystem",        desc: "Pace of improvement, tooling, docs, and community / research momentum." }
];

// The subjects benchmarked — exactly the categories requested, plus the field trackers.
export const SUBJECTS = [
  { id: "claude-code-cloud", name: "Claude Code — Cloud",  desc: "Claude Code in the cloud (web, remote sandboxes, GitHub Actions)." },
  { id: "claude-cli",        name: "Claude CLI",           desc: "The local Claude Code command-line agent." },
  { id: "claude-tools",      name: "Claude + Tools",       desc: "Claude driving MCP, tool use, Agent SDK, computer use, Managed Agents." },
  { id: "open-source",       name: "Open Source",          desc: "Open-weight models + open agent frameworks." },
  { id: "research",          name: "Research",             desc: "Frontier research + evaluation methodology." }
];

export const BENCHMARK_SCALE =
  "0 absent · 1 nascent · 2 usable · 3 solid · 4 strong · 5 best-in-class. Scores are seeded estimates (mid-2026) that the worker refines from sourced study runs; a score with a source URL has been studied, others are seed.";

// Seed scores: defensible mid-2026 estimates, clearly marked as seed (no source).
// Each scheduled run overwrites the studied subject's axes with sourced scores.
export const SEED_SCORES = {
  "claude-code-cloud": {
    autonomy: [5, "Runs full tasks in ephemeral cloud sandboxes; PR + CI loops."],
    tool_breadth: [4, "Repo, shell, web, GitHub; MCP servers attach."],
    convergence: [4, "Strong on scoped tasks; long autonomous runs still drift sometimes."],
    cost_of_pass: [3, "Frontier-model tokens + sandbox time; high success offsets cost."],
    context_scale: [5, "1M-token context; whole-repo reasoning."],
    deploy_friction: [3, "Managed by Anthropic; less control than self-hosting."],
    ecosystem: [5, "Fast-moving first-party surface with active docs."]
  },
  "claude-cli": {
    autonomy: [4, "Hooks, subagents, headless mode; you own the loop."],
    tool_breadth: [4, "Full local machine + MCP; bounded by your config."],
    convergence: [4, "Tight feedback locally; depends on harness discipline."],
    cost_of_pass: [4, "Local context is cheap; pay only for inference."],
    context_scale: [5, "1M-token context; local file access."],
    deploy_friction: [4, "Drops into terminals and CI; scriptable."],
    ecosystem: [5, "Rich CLI feature set; rapid releases."]
  },
  "claude-tools": {
    autonomy: [4, "Agent SDK + Managed Agents run long loops server-side."],
    tool_breadth: [5, "MCP + tool use + computer use spans almost any system."],
    convergence: [3, "Multi-system orchestration is where most thrash appears."],
    cost_of_pass: [3, "Extra tool round-trips add cost and failure surface."],
    context_scale: [5, "Inherits frontier-model context."],
    deploy_friction: [3, "Integration + auth + MCP wiring is real work."],
    ecosystem: [4, "MCP ecosystem growing fast but uneven in quality."]
  },
  "open-source": {
    autonomy: [3, "Open harnesses (OpenHands, Aider) automate, with more babysitting."],
    tool_breadth: [4, "Harness-dependent; can match closed tools with effort."],
    convergence: [2, "Open-weight base models thrash more on hard agentic tasks."],
    cost_of_pass: [5, "Cheapest tokens / self-hostable — sets the cost floor."],
    context_scale: [3, "Long-context open models exist but lag the frontier."],
    deploy_friction: [4, "Self-hostable; you own infra and ops burden."],
    ecosystem: [4, "Huge community; quality and stability vary widely."]
  },
  "research": {
    autonomy: [2, "Prototypes and papers, not turnkey products."],
    tool_breadth: [3, "Demonstrates new tool/agent patterns ahead of products."],
    convergence: [3, "Leading indicator of where reliability is heading."],
    cost_of_pass: [3, "Often compute-heavy; not cost-optimised."],
    context_scale: [4, "Pushes context + memory techniques forward."],
    deploy_friction: [2, "Research code rarely production-ready as-is."],
    ecosystem: [5, "arXiv + labs + evals move weekly; the leading edge."]
  }
};

// Normalise SEED_SCORES ([score, note] tuples) into {score, note, source:null} objects.
function normaliseScores(raw) {
  const out = {};
  for (const [subject, axes] of Object.entries(raw)) {
    out[subject] = {};
    for (const [axis, val] of Object.entries(axes)) {
      const [score, note] = Array.isArray(val) ? val : [val, ""];
      out[subject][axis] = { score, note, source: null, ts: null, seed: true };
    }
  }
  return out;
}

export const BENCHMARK = {
  axes: AXES,
  subjects: SUBJECTS,
  scale: BENCHMARK_SCALE,
  seedScores: normaliseScores(SEED_SCORES)
};

// A couple of seed findings so the dashboard isn't empty before the first run.
// model:"seed" marks these as illustrative placeholders, not studied output.
export const SEED_FINDINGS = [
  {
    id: "seed-1",
    subject: "claude-code-cloud",
    subjectName: "Claude Code — Cloud",
    ts: "2026-06-19T00:00:00.000Z",
    headline: "Seed: cloud sessions run unattended in ephemeral sandboxes",
    summary: "Placeholder finding illustrating the format. Once ANTHROPIC_API_KEY is set, scheduled runs replace these with sourced research on cloud autonomy, scheduling, and the deploy story.",
    points: [
      { text: "Claude Code on the web runs in isolated, ephemeral cloud containers cloned per session.", url: "https://code.claude.com/docs/en/claude-code-on-the-web" }
    ],
    model: "seed",
    trigger: "seed"
  },
  {
    id: "seed-2",
    subject: "research",
    subjectName: "Research",
    ts: "2026-06-19T00:00:00.000Z",
    headline: "Seed: SWE-bench remains the reference agentic-coding eval",
    summary: "Placeholder finding. Scheduled research-track runs will track new techniques, benchmarks, and eval methodology and file them here with sources.",
    points: [
      { text: "SWE-bench Verified is the common bar for agentic software-engineering capability.", url: "https://www.swebench.com" }
    ],
    model: "seed",
    trigger: "seed"
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function subjectForDate(date = new Date()) {
  return SCHEDULE[date.getUTCDay()] ?? "idle";
}

export function trackById(id) {
  return TRACKS.find((t) => t.id === id) || null;
}

export function subjectName(id) {
  return (SUBJECTS.find((s) => s.id === id) || trackById(id) || { name: id }).name;
}

// Build the research instruction for a study run.
export function studyTask(subjectId, { url, question } = {}) {
  const axisList = AXES.map((a) => `${a.id} (${a.name}: ${a.desc})`).join("\n  - ");
  const jsonSchema =
    '{\n' +
    '  "headline": "one line, <=100 chars",\n' +
    '  "summary": "<=120 words of what changed / what matters",\n' +
    '  "findings": [{"text": "specific finding", "url": "https://source"}],\n' +
    '  "scores": {"<axis_id>": {"score": 0-5, "note": "one-line justification"}}\n' +
    '}';

  if (subjectId === "synthesis") {
    return (
      "You are the synthesis pass for an AI-capability study. Search the web for the most " +
      "important AI developments of the past week across: Claude Code (cloud + CLI), Claude " +
      "tool-use / MCP / agents, open-source models and agent frameworks, and AI research / evals. " +
      "Identify the 4-6 developments that most change how one should deploy AI to self-manage work " +
      "or engineer solutions.\n\n" +
      "Be concrete and cite a source URL for each point. Lead with the outcome.\n\n" +
      "End your reply with a single fenced ```json code block (no scores needed; set \"scores\": {}) " +
      "matching:\n```json\n" + jsonSchema + "\n```"
    );
  }

  const track = trackById(subjectId);
  const name = track ? track.name : subjectId;
  const goal = track ? track.goal : `Study ${subjectId}.`;
  const qs = track ? track.questions.map((q) => "  - " + q).join("\n") : "";
  const sources = track ? track.seedSources.join(", ") : "";

  let lead =
    `You are an AI-capability analyst studying the subject "${name}".\n` +
    `Goal: ${goal}\n\n` +
    "Use web_search to find the LATEST (2026) developments. Prefer primary sources " +
    `(official docs, vendor announcements, papers, well-run benchmarks). Starting points you may go beyond: ${sources}.\n\n` +
    (qs ? `Anchor questions:\n${qs}\n\n` : "");

  if (url) {
    lead +=
      `Study this specific link in depth as part of this run (use web_fetch): ${url}\n\n`;
  }
  if (question) {
    lead += `Pay special attention to this question from the operator: ${question}\n\n`;
  }

  lead +=
    "Produce: (1) a headline, (2) a <=120-word synthesis of what's new and why it matters, " +
    "(3) 3-6 specific findings each with a source URL, and (4) updated benchmark scores for THIS " +
    "subject on the axes below (only include axes you can justify from what you found):\n  - " +
    axisList +
    "\n\nScale: 0 absent · 1 nascent · 2 usable · 3 solid · 4 strong · 5 best-in-class. " +
    "Be honest and specific; a score without evidence is worthless.\n\n" +
    "End your reply with a single fenced ```json code block matching exactly:\n```json\n" +
    jsonSchema +
    "\n```";

  return lead;
}

// System prompt for the chat assistant. Tuned for Opus 4.8 (search-first, concise,
// lead-with-outcome) and given the accumulated study corpus as context.
export function chatSystem(digest) {
  return (
    "You are intellistudy, a research analyst that helps the operator parse and act on an " +
    "ongoing study of AI capability. Your job: turn the accumulated findings and benchmark into " +
    "decisions about how to deploy AI to self-manage work or engineer solutions in their stack.\n\n" +
    "Operating rules:\n" +
    "- Lead with the outcome: your first sentence answers the question; detail follows.\n" +
    "- Be concise and specific. Prefer recommendations over surveys. Use plain prose, not arrow-chains.\n" +
    "- For anything time-sensitive (current capabilities, prices, releases), use web_search before " +
    "answering rather than answering from memory. If a link is provided, study it with web_fetch.\n" +
    "- Ground claims in the corpus or in sources you cite; flag what is seed/unverified.\n\n" +
    "Current study corpus (most recent first):\n" +
    digest
  );
}

// Compact text digest of the corpus for chat context. Bounded for token cost.
export function buildDigest(state, { maxFindings = 14 } = {}) {
  const lines = [];
  const b = state.benchmark;
  if (b && b.scores) {
    lines.push("BENCHMARK (avg score / 5 per subject):");
    for (const subj of b.subjects) {
      const axes = b.scores[subj.id] || {};
      const vals = Object.values(axes).map((x) => x.score).filter((n) => typeof n === "number");
      const avg = vals.length ? (vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(1) : "—";
      lines.push(`  - ${subj.name}: ${avg}`);
    }
  }
  const findings = (state.findings || []).slice(0, maxFindings);
  if (findings.length) {
    lines.push("", "RECENT FINDINGS:");
    for (const f of findings) {
      lines.push(`  - [${f.subjectName || f.subject}] ${f.headline || f.summary || ""}`.slice(0, 240));
      for (const p of (f.points || []).slice(0, 2)) {
        if (p && p.text) lines.push(`      • ${p.text}${p.url ? " (" + p.url + ")" : ""}`.slice(0, 280));
      }
    }
  }
  if (!lines.length) lines.push("(no findings yet — scheduled study runs will populate this)");
  return lines.join("\n");
}
