// Generated view: the commercial benchmark scoreboard.
// Renders subjects × axes from data.benchmark, colored by score, with per-cell
// notes/sources. Re-fetches /data/state.json on the 'usai:refresh' event so it
// updates live after a study run. Contract: HUB.registerView({id,title,group,render}).
HUB.registerView({
  id: "benchmark",
  title: "Commercial benchmark · subjects × axes",
  group: "benchmark",
  render(data, el) {
    const scoreColor = (s) =>
      s >= 4 ? "var(--converge)" : s >= 3 ? "var(--cool)" : s >= 2 ? "var(--signal)" : "var(--thrash)";

    const draw = (d) => {
      const b = d && d.benchmark;
      if (!b || !b.subjects) {
        el.innerHTML = '<div class="vnote">no benchmark data</div>';
        return;
      }
      const axes = b.axes || [];
      const head =
        "<tr><th>subject</th>" +
        axes.map((a) => `<th title="${(a.desc || "").replace(/"/g, "&quot;")}">${a.name}</th>`).join("") +
        "<th>avg</th></tr>";

      const rows = b.subjects
        .map((subj) => {
          const cells = b.scores[subj.id] || {};
          const vals = [];
          const tds = axes
            .map((a) => {
              const c = cells[a.id];
              if (!c || typeof c.score !== "number")
                return '<td style="color:var(--faint)">·</td>';
              vals.push(c.score);
              const seed = c.seed ? ";opacity:.55" : "";
              const tip = `${a.name}: ${(c.note || "").replace(/"/g, "&quot;")}${c.source ? " — " + c.source : c.seed ? " — (seed)" : ""}`;
              const src = c.source
                ? `<a href="${c.source}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${c.score}</a>`
                : c.score;
              return `<td style="color:${scoreColor(c.score)};font-weight:600${seed}" title="${tip}">${src}</td>`;
            })
            .join("");
          const avg = vals.length ? (vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(1) : "—";
          return (
            `<tr><td style="color:var(--paper)" title="${(subj.desc || "").replace(/"/g, "&quot;")}">${subj.name}</td>` +
            tds +
            `<td style="color:${avg === "—" ? "var(--faint)" : scoreColor(Number(avg))};font-weight:700">${avg}</td></tr>`
          );
        })
        .join("");

      el.innerHTML =
        `<table class="vt"><thead>${head}</thead><tbody>${rows}</tbody></table>` +
        `<div class="vnote">${b.scale || ""}</div>` +
        `<div class="vnote">dim = seed estimate · bright = studied (click a score for its source)</div>`;
    };

    draw(data);
    // Live refresh after a study run.
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
