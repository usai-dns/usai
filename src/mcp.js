// mcp.js — intellistudy as an MCP server (directive §6).
//
// Streamable-HTTP transport, single-tenant, token-gated (the worker's ACCESS_TOKEN
// gate covers /mcp). Any MCP client — Claude Code, claude.ai, a model under test —
// gets the SAME tool surface as the built-in chat (tools.js), so driving the lab
// over MCP is itself a measurable agentic task.
//
// Connect from Claude Code:
//   claude mcp add --transport http intellistudy https://<host>/mcp \
//     --header "x-usai-key: <ACCESS_TOKEN>"
//
// JSON-RPC methods: initialize, ping, tools/list, tools/call (+ notifications).
// tools/call responds as SSE with keepalive comments so long runs (benchmarks)
// survive client/edge timeouts; everything else is plain JSON.

import { TOOL_DEFS, execTool } from "./tools.js";

// Directive §6 names that map onto the canonical registry.
const ALIASES = {
  define_experiment: "create_benchmark",
  run_experiment: "run_benchmark",
  list_benchmarks: "list_library"
};

const PROTOCOL = "2025-06-18";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function toolList() {
  const canonical = TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema }));
  const aliases = Object.entries(ALIASES).map(([alias, target]) => {
    const t = TOOL_DEFS.find((d) => d.name === target);
    return { name: alias, description: `(directive alias for ${target}) ` + t.description, inputSchema: t.input_schema };
  });
  return [...canonical, ...aliases];
}

export async function handleMcp(request, env) {
  if (request.method === "DELETE") return new Response(null, { status: 200 }); // session teardown: stateless, nothing to do
  if (request.method !== "POST") return jsonResponse(rpcError(null, -32600, "POST only (stateless streamable HTTP)"), 405);

  let msg;
  try {
    msg = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "parse error"), 400);
  }
  if (Array.isArray(msg)) msg = msg[0]; // batching: handle the first (clients we target don't batch)

  const { id, method, params } = msg || {};

  // notifications (no id) are acknowledged and dropped
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return jsonResponse(rpcResult(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "intellistudy", version: "2.1.0" }
    }));
  }
  if (method === "ping") return jsonResponse(rpcResult(id, {}));
  if (method === "tools/list") return jsonResponse(rpcResult(id, { tools: toolList() }));

  if (method === "tools/call") {
    const rawName = params?.name || "";
    const name = ALIASES[rawName] || rawName;
    if (!TOOL_DEFS.some((d) => d.name === name)) {
      return jsonResponse(rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool " + rawName }) }], isError: true }));
    }
    // SSE response: keepalive comments while the tool executes (runs take minutes),
    // then the JSON-RPC response as a message event. Progress lines are appended
    // to the result text so the driving model sees them.
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (s) => controller.enqueue(enc.encode(s));
        const beat = setInterval(() => { try { send(": keepalive\n\n"); } catch {} }, 10000);
        const progress = [];
        try {
          const out = await execTool(env, name, params?.arguments || {}, (ev) => {
            if (ev.t === "progress") progress.push(ev.s);
          });
          const text = progress.length ? "progress:\n" + progress.join("\n") + "\n\nresult:\n" + out : out;
          send("event: message\ndata: " + JSON.stringify(rpcResult(id, { content: [{ type: "text", text }], isError: false })) + "\n\n");
        } catch (e) {
          const text = JSON.stringify({ error: (e?.message || String(e)).slice(0, 400), progress });
          send("event: message\ndata: " + JSON.stringify(rpcResult(id, { content: [{ type: "text", text }], isError: true })) + "\n\n");
        } finally {
          clearInterval(beat);
          controller.close();
        }
      }
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" }
    });
  }

  return jsonResponse(rpcError(id, -32601, "method not found: " + method));
}
