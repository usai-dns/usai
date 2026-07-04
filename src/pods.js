// pods.js — RunPod provisioning: stand up open-weight models behind vLLM's
// OpenAI-compatible endpoint, meter them by pod-hour, and tear them down.
//
// Lifecycle (directive §4): provision → readiness → benchmark → terminate.
// Safety rails:
//   - every pod carries a TTL (default 2h, max 8h); the hourly cron reaps
//     expired pods so a forgotten pod can't burn money overnight.
//   - provisioning enforces rate × TTL ≤ the standing $50 cap and always
//     reports $/hr before and after.
// Requires the RUNPOD_API_KEY secret; everything degrades gracefully without it.
//
// REST shapes verified against docs.runpod.io (2026-07):
//   POST   https://rest.runpod.io/v1/pods          (create; Bearer auth)
//   GET    /pods, /pods/{id}                        (list/get)
//   DELETE /pods/{id}                               (terminate)
//   proxy: https://{POD_ID}-{PORT}.proxy.runpod.net

const BASE = "https://rest.runpod.io/v1";
const PODS_KEY = "pods"; // KV registry: our metadata (ttl, model, rate) per pod

export function hasRunpod(env) {
  return Boolean(env && env.RUNPOD_API_KEY);
}

async function rp(env, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: "Bearer " + env.RUNPOD_API_KEY,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`RunPod ${method} ${path} → ${res.status}: ${(text || "").slice(0, 300)}`);
  return data;
}

// GPU tiers → acceptable RunPod GPU type ids (create accepts an array of candidates).
export const GPU_TIERS = {
  "24gb": { ids: ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000"], disk: 60, estPerHr: "~$0.3-0.7" },
  "48gb": { ids: ["NVIDIA RTX A6000", "NVIDIA A40", "NVIDIA L40S"], disk: 150, estPerHr: "~$0.8-1.3" },
  "80gb": { ids: ["NVIDIA A100 80GB PCIe", "NVIDIA H100 PCIe", "NVIDIA H100 80GB HBM3"], disk: 300, estPerHr: "~$1.6-3.5" }
};

// Curated open-weight roster (directive §3) — suggestions, not an allowlist;
// provision_pod accepts any HF repo. Re-verify "latest gen" via the weekly scan.
export const ROSTER = [
  { ref: "Qwen/Qwen3-8B", tier: "24gb", why: "current-gen small Qwen; strong structured output" },
  { ref: "Qwen/Qwen2.5-7B-Instruct", tier: "24gb", why: "proven extraction track record" },
  { ref: "Qwen/Qwen3-32B", tier: "80gb", why: "mid-size reasoning/extraction workhorse" },
  { ref: "Qwen/Qwen2.5-Coder-32B-Instruct", tier: "80gb", why: "open coding reference" },
  { ref: "meta-llama/Llama-3.1-8B-Instruct", tier: "24gb", why: "ecosystem baseline (HF-gated: needs HF_TOKEN)" },
  { ref: "meta-llama/Llama-3.3-70B-Instruct", tier: "80gb", why: "large Llama baseline (gated; 4-bit fits 80GB)" },
  { ref: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", tier: "80gb", why: "reasoning-per-dollar distill" },
  { ref: "mistralai/Mistral-Small-3.1-24B-Instruct-2503", tier: "48gb", why: "latency-tier candidate" },
  { ref: "openai/gpt-oss-20b", tier: "24gb", why: "per Harness-1 finding; strong in managed harnesses" }
];

const MAX_TTL_H = 8;
const STANDING_CAP_USD = 50;

async function registry(env) {
  if (!env.USAI_KV) return [];
  try { return (await env.USAI_KV.get(PODS_KEY, "json")) || []; } catch { return []; }
}
async function saveRegistry(env, pods) {
  if (env.USAI_KV) await env.USAI_KV.put(PODS_KEY, JSON.stringify(pods.slice(0, 30)));
}

export function proxyUrl(podId, port = 8000) {
  return `https://${podId}-${port}.proxy.runpod.net`;
}

// Create a vLLM pod serving `modelRef`. Returns the registry entry.
export async function provisionPod(env, { modelRef, tier = "24gb", ttlHours = 2, maxModelLen = 8192, extraArgs = [], name }) {
  if (!hasRunpod(env)) throw new Error("RUNPOD_API_KEY not set — provisioning disabled");
  const t = GPU_TIERS[tier];
  if (!t) throw new Error(`unknown tier "${tier}" — use ${Object.keys(GPU_TIERS).join("|")}`);
  const ttl = Math.min(Math.max(0.25, Number(ttlHours) || 2), MAX_TTL_H);

  const cmd = [
    "--model", modelRef,
    "--host", "0.0.0.0", "--port", "8000",
    "--max-model-len", String(maxModelLen),
    "--gpu-memory-utilization", "0.92",
    ...extraArgs.map(String).slice(0, 12)
  ];
  const envVars = {};
  if (env.HF_TOKEN) envVars.HF_TOKEN = env.HF_TOKEN; // gated repos (Llama etc.)

  const pod = await rp(env, "POST", "/pods", {
    name: (name || `usai-${modelRef.split("/").pop()}`).slice(0, 60),
    computeType: "GPU",
    cloudType: "SECURE",
    imageName: "vllm/vllm-openai:latest",
    gpuTypeIds: t.ids,
    gpuCount: 1,
    containerDiskInGb: t.disk,
    volumeInGb: 0,
    ports: ["8000/http"],
    env: envVars,
    dockerStartCmd: cmd
  });

  const rate = Number(pod.costPerHr ?? pod.adjustedCostPerHr) || null;
  if (rate && rate * ttl > STANDING_CAP_USD) {
    // over the standing cap — terminate immediately rather than leave it running
    try { await rp(env, "DELETE", "/pods/" + pod.id); } catch {}
    throw new Error(`pod rate $${rate}/hr × ${ttl}h TTL exceeds the $${STANDING_CAP_USD} standing cap — provision a smaller tier or shorter TTL`);
  }

  const entry = {
    id: pod.id,
    name: pod.name,
    modelRef,
    tier,
    gpuTypeIds: t.ids,
    costPerHr: rate,
    ttlHours: ttl,
    created: new Date().toISOString(),
    endpoint: proxyUrl(pod.id, 8000),
    status: pod.desiredStatus || "STARTING"
  };
  const pods = (await registry(env)).filter((p) => p.id !== entry.id);
  pods.unshift(entry);
  await saveRegistry(env, pods);
  return entry;
}

// One readiness probe: vLLM's /v1/models answers once weights are loaded.
export async function podStatus(env, podId) {
  const pods = await registry(env);
  const entry = pods.find((p) => p.id === podId) || { id: podId, endpoint: proxyUrl(podId) };
  let live = null;
  if (hasRunpod(env)) {
    try { live = await rp(env, "GET", "/pods/" + podId); } catch (e) { live = { error: String(e.message || e).slice(0, 200) }; }
  }
  let ready = false, servedModel = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(entry.endpoint + "/v1/models", { signal: ctl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const j = await r.json();
      servedModel = j?.data?.[0]?.id || null;
      ready = Boolean(servedModel);
    }
  } catch {}
  const status = {
    ...entry,
    desiredStatus: live?.desiredStatus || entry.status,
    costPerHr: Number(live?.costPerHr) || entry.costPerHr,
    ready,
    servedModel,
    ageMinutes: entry.created ? Math.round((Date.now() - new Date(entry.created).getTime()) / 60000) : null,
    spendSoFarUsd: entry.created && entry.costPerHr
      ? Math.round(entry.costPerHr * ((Date.now() - new Date(entry.created).getTime()) / 3600000) * 100) / 100
      : null
  };
  if (ready && entry.id) {
    const updated = pods.map((p) => (p.id === podId ? { ...p, status: "READY", servedModel } : p));
    await saveRegistry(env, updated);
  }
  return status;
}

export async function listPods(env) {
  const pods = await registry(env);
  return pods.map((p) => ({
    ...p,
    ageMinutes: p.created ? Math.round((Date.now() - new Date(p.created).getTime()) / 60000) : null,
    expiresInMinutes: p.created ? Math.round(p.ttlHours * 60 - (Date.now() - new Date(p.created).getTime()) / 60000) : null
  }));
}

export async function terminatePod(env, podId) {
  if (!hasRunpod(env)) throw new Error("RUNPOD_API_KEY not set");
  let apiError = null;
  try { await rp(env, "DELETE", "/pods/" + podId); } catch (e) { apiError = String(e.message || e); }
  const pods = await registry(env);
  const entry = pods.find((p) => p.id === podId);
  await saveRegistry(env, pods.filter((p) => p.id !== podId));
  const spend = entry && entry.created && entry.costPerHr
    ? Math.round(entry.costPerHr * ((Date.now() - new Date(entry.created).getTime()) / 3600000) * 100) / 100
    : null;
  return { terminated: podId, approxSpendUsd: spend, apiError };
}

// Hourly cron: kill anything past its TTL. Returns human-readable log lines.
export async function reapExpired(env) {
  if (!hasRunpod(env)) return [];
  const pods = await registry(env);
  const out = [];
  for (const p of pods) {
    const ageH = (Date.now() - new Date(p.created).getTime()) / 3600000;
    if (ageH > (p.ttlHours || 2)) {
      const r = await terminatePod(env, p.id).catch((e) => ({ apiError: String(e) }));
      out.push(`reaped pod ${p.id} (${p.modelRef}) after ${ageH.toFixed(1)}h TTL${r.approxSpendUsd != null ? ` — ~$${r.approxSpendUsd}` : ""}`);
    }
  }
  return out;
}

// OpenAI-compatible chat call against a pod's vLLM endpoint, metered by pod-hour.
// Cost model: costPerHr × call wall-clock, serially amortized — an upper bound
// when cells run in parallel (the pod bills by the hour regardless). Documented in METHODS.
export async function callVllm(env, pod, { messages, maxTokens = 1500, temperature = 0 }) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(pod.endpoint + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: pod.servedModel || pod.modelRef, messages, max_tokens: maxTokens, temperature }),
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.choices?.[0]?.message?.content || "").trim();
  const usage = j.usage || {};
  const cost = pod.costPerHr ? pod.costPerHr * (ms / 3600000) : 0;
  return {
    text,
    refused: false,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    ms,
    cost: Math.round(cost * 10000) / 10000,
    servedModel: j.model || pod.servedModel || pod.modelRef
  };
}
