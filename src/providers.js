// providers.js — multi-provider access (directive §3 frontier API tier).
//
// One OpenAI-compatible client covers OpenAI and Google (Gemini ships an
// OpenAI-compat endpoint), which also makes the lab extensible to anything
// speaking that dialect. Anthropic keeps its native SDK path (lab.js); vLLM
// pods keep theirs (pods.js).
//
// A dropped-in key unlocks the provider on BOTH axes:
//   driver  — that model can operate the lab (chat loop in agent.js)
//   subject — benchmark variants with provider:"openai"|"google"
//
// R4 note: unknown models may be benchmarked ONLY with an explicit per-variant
// pricing override — a result without cost is discarded, so we refuse to meter
// blind rather than guess.

const ENDPOINTS = {
  openai: { base: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY" },
  google: { base: "https://generativelanguage.googleapis.com/v1beta/openai", keyVar: "GEMINI_API_KEY" }
};

// Default driver model per provider (the model that operates the lab when selected).
export const DRIVER_DEFAULTS = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5",
  google: "gemini-2.5-pro"
};

export function providerOf(model) {
  if (/^claude/i.test(model)) return "anthropic";
  if (/^(gpt|o\d)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return null;
}

export function hasProvider(env, provider) {
  if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
  const e = ENDPOINTS[provider];
  return Boolean(e && env[e.keyVar]);
}

// Drivers available on this deployment (keys present), for the UI picker + §7 logging.
export function availableDrivers(env) {
  return Object.entries(DRIVER_DEFAULTS)
    .filter(([p]) => hasProvider(env, p))
    .map(([provider, model]) => ({ provider, model }));
}

export function resolveDriver(env, requested) {
  const model = (requested || DRIVER_DEFAULTS.anthropic).trim();
  const provider = providerOf(model);
  if (!provider) return { error: `unknown driver model "${model}" — use a claude-*, gpt-*/o*, or gemini-* id` };
  if (!hasProvider(env, provider)) {
    const need = provider === "anthropic" ? "ANTHROPIC_API_KEY" : ENDPOINTS[provider].keyVar;
    return { error: `driver "${model}" needs the ${need} secret (npx wrangler secret put ${need})` };
  }
  return { provider, model };
}

// One OpenAI-compatible chat call, normalized to the lab's call shape.
// - OpenAI reasoning models want max_completion_tokens and reject temperature;
//   effort maps to reasoning_effort. Gemini's compat layer takes max_tokens.
export async function callOpenAICompat(env, { provider, model, messages, maxTokens = 1500, effort, tools, pricing }) {
  const e = ENDPOINTS[provider];
  if (!e || !env[e.keyVar]) throw new Error(`${provider} key not configured`);
  const body = { model, messages };
  if (provider === "openai") {
    body.max_completion_tokens = maxTokens;
    if (effort) body.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
  } else {
    body.max_tokens = maxTokens;
    body.temperature = 0;
    if (effort) body.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
  }
  if (tools && tools.length) body.tools = tools;

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch(e.base + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + env[e.keyVar], "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const choice = j.choices?.[0] || {};
  const usage = j.usage || {};
  const inTok = usage.prompt_tokens || 0, outTok = usage.completion_tokens || 0;
  const cost = pricing ? (inTok * pricing.in + outTok * pricing.out) / 1e6 : null;
  return {
    text: (choice.message?.content || "").trim(),
    toolCalls: choice.message?.tool_calls || [],
    finishReason: choice.finish_reason,
    refused: false,
    usage: { input_tokens: inTok, output_tokens: outTok },
    ms,
    cost: cost === null ? null : Math.round(cost * 10000) / 10000,
    servedModel: j.model || model
  };
}
