// Generated view: the Kaggle Benchmarks leaderboard — external model standings
// pulled by the Kaggle study run (data.kaggle). Re-fetches on 'usai:refresh'.
// Contract: HUB.registerView({id,title,group,render}).
HUB.registerView({
  id: "kaggle",
  title: "Kaggle Benchmarks · external leaderboard",
  group: "eval",
  render(data, el) {
    const fmt = (ts) => {
      try {
        return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + "Z";
      } catch {
        return ts || "";
      }
    };

    const draw = (d) => {
      const k = d && d.kaggle;
      if (!k || !Array.isArray(k.leaderboard) || !k.leaderboard.length) {
        el.innerHTML =
          '<div class="empty">No Kaggle standings yet. Run the <b>kaggle</b> study (chat → “Run now”, or it runs Saturdays) to pull current leaderboard standings into this board.</div>';
        return;
      }
      const rows = k.leaderboard
        .map((r, i) => {
          const model = r.url
            ? `<a href="${r.url}" target="_blank" rel="noopener" style="color:var(--paper);text-decoration:none">${r.model}</a>`
            : `<span style="color:var(--paper)">${r.model}</span>`;
          return (
            `<tr>` +
            `<td style="color:var(--faint)">${i + 1}</td>` +
            `<td>${model}</td>` +
            `<td style="color:var(--converge);font-weight:600">${r.score || "—"}</td>` +
            `<td style="color:var(--muted)">${r.benchmark || "—"}</td>` +
            `</tr>`
          );
        })
        .join("");
      el.innerHTML =
        `<table class="vt"><thead><tr><th>#</th><th>model</th><th>score</th><th>benchmark</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>` +
        (k.headline ? `<div class="vnote" style="color:var(--muted)">${k.headline}</div>` : "") +
        `<div class="vnote">pulled ${fmt(k.updated)}${k.source ? ` · <a href="${k.source}" target="_blank" rel="noopener" style="color:var(--cool)">source</a>` : ""} · kaggle.com/benchmarks. Standings are model-reported via web search — verify before quoting.</div>`;
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
