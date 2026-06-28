// Generated view: the chat interface + manual study trigger.
//   • Chat box  → POST /api/chat (streams Claude's answer over the study corpus).
//   • Study row → POST /api/study/run (runs one research pass, files a finding,
//                 then fires 'usai:refresh' so the benchmark + findings views update).
// Contract: HUB.registerView({id,title,group,render}).
HUB.registerView({
  id: "chat",
  title: "Chat · parse & steer the study",
  group: "interface",
  render(data, el) {
    const tracks = (data && data.studies && data.studies.tracks) || [];
    const hasKey = !(data && data.meta) || data.meta.hasKey !== false;

    el.innerHTML = `
      <div id="usaiLog" style="display:flex;flex-direction:column;gap:10px;max-height:340px;overflow:auto;padding:4px 2px 10px"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <textarea id="usaiMsg" rows="2" placeholder="Ask about the findings, the benchmark, or what to deploy…"
          style="flex:1;resize:vertical;background:var(--ink-2);color:var(--paper);border:1px solid var(--line-2);border-radius:8px;padding:9px 11px;font-family:var(--body);font-size:13px"></textarea>
        <button id="usaiSend" style="align-self:stretch;background:var(--signal);color:var(--ink);border:0;border-radius:8px;padding:0 16px;font-family:var(--disp);font-weight:600;cursor:pointer">Send</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);padding-top:10px">
        <span class="vnote" style="margin:0">Study &amp; file →</span>
        <select id="usaiSubj" style="background:var(--ink-2);color:var(--paper);border:1px solid var(--line-2);border-radius:6px;padding:5px 8px;font-family:var(--mono);font-size:11px">
          ${tracks.map((t) => `<option value="${t.id}">${t.name}</option>`).join("")}
        </select>
        <input id="usaiUrl" placeholder="optional link to study (https://…)"
          style="flex:1;min-width:160px;background:var(--ink-2);color:var(--paper);border:1px solid var(--line-2);border-radius:6px;padding:6px 9px;font-family:var(--mono);font-size:11px" />
        <button id="usaiRun" style="background:transparent;color:var(--cool);border:1px solid var(--line-2);border-radius:6px;padding:6px 12px;font-family:var(--mono);font-size:11px;cursor:pointer">Run now</button>
      </div>
      <div id="usaiStatus" class="vnote" style="margin-top:8px"></div>`;

    const log = el.querySelector("#usaiLog");
    const msgBox = el.querySelector("#usaiMsg");
    const sendBtn = el.querySelector("#usaiSend");
    const runBtn = el.querySelector("#usaiRun");
    const status = el.querySelector("#usaiStatus");
    const messages = [];

    if (!hasKey) {
      status.innerHTML =
        '⚠️ No <code style="color:var(--cool)">ANTHROPIC_API_KEY</code> set — chat &amp; study will return setup instructions. The dashboard works without it.';
    }

    const bubble = (role, text) => {
      const wrap = document.createElement("div");
      const me = role === "user";
      wrap.style.cssText = `align-self:${me ? "flex-end" : "flex-start"};max-width:88%;background:${me ? "var(--line)" : "var(--panel)"};border:1px solid var(--line-2);border-radius:10px;padding:8px 11px;font-size:13px;white-space:pre-wrap;line-height:1.5;color:${me ? "var(--paper)" : "var(--paper)"}`;
      wrap.textContent = text;
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      return wrap;
    };

    async function send() {
      const text = msgBox.value.trim();
      if (!text) return;
      msgBox.value = "";
      sendBtn.disabled = true;
      messages.push({ role: "user", content: text });
      bubble("user", text);
      const out = bubble("assistant", "…");
      let acc = "";
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages })
        });
        if (res.headers.get("x-usai-status") === "no-key") {
          out.textContent = await res.text();
        } else if (!res.body) {
          out.textContent = await res.text();
        } else {
          out.textContent = "";
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            acc += dec.decode(value, { stream: true });
            out.textContent = acc;
            log.scrollTop = log.scrollHeight;
          }
        }
      } catch (e) {
        out.textContent = "⚠️ " + (e && e.message ? e.message : e);
      }
      if (acc) messages.push({ role: "assistant", content: acc });
      sendBtn.disabled = false;
    }

    async function runStudy() {
      const subject = el.querySelector("#usaiSubj").value;
      const url = el.querySelector("#usaiUrl").value.trim();
      runBtn.disabled = true;
      // The request runs the research synchronously and returns the finding;
      // it can take ~1-2 min, so show progress and let the fetch wait.
      status.textContent = `Studying ${subject}${url ? " + " + url : ""}… this can take ~1 min, hang tight.`;
      try {
        const res = await fetch("/api/study/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject, url: url || undefined })
        });
        if (res.status === 400) {
          const d = await res.json().catch(() => ({}));
          status.textContent = "⚠️ " + (d.error || "study failed") + (d.detail ? " — " + d.detail : "");
          runBtn.disabled = false;
          return;
        }
        // Streamed response: whitespace heartbeats + a final JSON line.
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text.trim());
        } catch {
          data = { error: "could not parse study result" };
        }
        if (data.error) {
          status.textContent = "⚠️ " + data.error + (data.detail ? " — " + data.detail : "");
        } else {
          status.innerHTML = `✓ Filed: <b style="color:var(--paper)">${data.headline || data.subjectName || subject}</b>. Findings &amp; benchmark updated.`;
          el.querySelector("#usaiUrl").value = "";
          window.dispatchEvent(new CustomEvent("usai:refresh"));
        }
      } catch (e) {
        status.textContent = "⚠️ " + (e && e.message ? e.message : e);
      }
      runBtn.disabled = false;
    }

    sendBtn.addEventListener("click", send);
    msgBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
    });
    runBtn.addEventListener("click", runStudy);
  }
});
