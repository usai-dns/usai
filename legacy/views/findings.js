// Generated view: accumulated study findings (newest first), written by the
// scheduled worker / manual runs. Re-fetches on 'usai:refresh'. Contract: HUB.registerView.
HUB.registerView({
  id: "findings",
  title: "Findings · study log",
  group: "studies",
  render(data, el) {
    const fmt = (ts) => {
      try {
        return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + "Z";
      } catch {
        return ts || "";
      }
    };

    const draw = (d) => {
      const findings = (d && d.findings) || [];
      if (!findings.length) {
        el.innerHTML =
          '<div class="empty">No findings yet. Scheduled study runs (or “Study &amp; file” in the chat view) will populate this.</div>';
        return;
      }
      el.innerHTML = findings
        .slice(0, 40)
        .map((f) => {
          const seed = f.model === "seed";
          const tagColor = seed ? "var(--faint)" : "var(--signal)";
          const points = (f.points || [])
            .filter((p) => p && p.text)
            .map(
              (p) =>
                `<li style="margin:3px 0">${p.text}${p.url ? ` <a href="${p.url}" target="_blank" rel="noopener" style="color:var(--cool);font-size:11px">[src]</a>` : ""}</li>`
            )
            .join("");
          return (
            `<div style="border-top:1px solid var(--line);padding:11px 0">` +
            `<div style="display:flex;align-items:baseline;gap:8px">` +
            `<span class="chip" style="color:${tagColor};padding:1px 6px">${f.subjectName || f.subject}</span>` +
            `<span style="color:var(--paper);font-weight:500">${f.headline || ""}</span>` +
            `<span class="mt" style="margin-left:auto;font-family:var(--mono);font-size:9.5px;color:var(--faint)">${fmt(f.ts)}${seed ? " · seed" : " · " + (f.trigger || "")}</span>` +
            `</div>` +
            (f.summary && f.summary !== f.headline ? `<div class="vnote" style="margin:5px 0;color:var(--muted)">${f.summary}</div>` : "") +
            (points ? `<ul style="margin:5px 0 2px 16px;padding:0;font-size:12px;color:var(--muted)">${points}</ul>` : "") +
            `</div>`
          );
        })
        .join("");
    };

    draw(data);
    if (!el.__usaiWired) {
      el.__usaiWired = true;
      window.addEventListener("usai:refresh", async () => {
        try {
          const r = await fetch("/data/state.json", { cache: "no-store" });
          if (r.ok) draw(await r.json());
        } catch (e) {}
      });
    }
  }
});
