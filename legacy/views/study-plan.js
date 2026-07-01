// Generated view: the study regimen — cadence, weekly schedule, and tracks.
// Renders data.studies. Static (no live refresh needed). Contract: HUB.registerView.
HUB.registerView({
  id: "study-plan",
  title: "Study plan · regimen & tracks",
  group: "studies",
  render(data, el) {
    const s = data && data.studies;
    if (!s) {
      el.innerHTML = '<div class="vnote">no study plan</div>';
      return;
    }

    const cadence = `<div class="vnote" style="margin:0 0 12px">${s.cadence || ""}</div>`;

    // Weekly schedule as a row of day chips.
    const sched =
      '<div class="chips" style="margin-bottom:14px">' +
      (s.schedule || [])
        .map((d) => {
          const idle = d.subject === "idle";
          const synth = d.subject === "synthesis";
          const color = idle ? "var(--faint)" : synth ? "var(--cool)" : "var(--signal)";
          return `<span class="chip" style="color:${color}">${d.day} · ${d.subject}</span>`;
        })
        .join("") +
      "</div>";

    // Each track as a block.
    const tracks = (s.tracks || [])
      .map((t) => {
        const qs = (t.questions || [])
          .map((q) => `<li style="margin:2px 0">${q}</li>`)
          .join("");
        const sources = (t.seedSources || [])
          .map(
            (u) =>
              `<a class="chip" href="${u}" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:none">${u.replace(/^https?:\/\//, "").slice(0, 38)}</a>`
          )
          .join("");
        return (
          `<div style="border-top:1px solid var(--line);padding:12px 0">` +
          `<div style="display:flex;align-items:baseline;gap:8px">` +
          `<span style="font-family:var(--mono);font-size:10px;color:var(--signal)">${t.id}</span>` +
          `<span style="font-family:var(--disp);font-weight:600;color:var(--paper)">${t.name}</span></div>` +
          `<div class="vnote" style="margin:6px 0;color:var(--muted)">${t.goal || ""}</div>` +
          (t.why ? `<div class="vnote" style="margin:6px 0;color:var(--faint)"><b style="color:var(--faint)">why:</b> ${t.why}</div>` : "") +
          (qs ? `<ul style="margin:6px 0 8px 16px;padding:0;font-size:12px;color:var(--muted)">${qs}</ul>` : "") +
          `<div class="chips">${sources}</div>` +
          `</div>`
        );
      })
      .join("");

    el.innerHTML = cadence + sched + tracks;
  }
});
