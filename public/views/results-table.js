// A generated view-component. Reads canonical results and renders a cost-of-pass table.
// Promoted from the inline fallback in the shell into a real views/ module so live mode
// renders it. Contract: call HUB.registerView({ id, title, group, render(data, el) }).
HUB.registerView({
  id: 'results-table',
  title: 'Results · cost-of-pass',
  group: 'results',
  render(data, el) {
    const rows = (data.results || []).map(r =>
      `<tr>`
      + `<td>${r.exp}</td>`
      + `<td style="color:var(--paper)">${r.varied}</td>`
      + `<td style="color:${r.outcome === 'pass' ? 'var(--converge)' : 'var(--thrash)'}">${r.outcome}</td>`
      + `<td>$${(r.cost ?? 0).toFixed(3)}</td>`
      + `<td>${r.time ?? '—'}m</td>`
      + `<td style="color:var(--converge)">${r.outcome === 'pass' ? '$' + (r.cost ?? 0).toFixed(3) : '—'}</td>`
      + `</tr>`
    ).join('');
    el.innerHTML =
      `<table class="vt">`
      + `<thead><tr><th>exp</th><th>varied</th><th>result</th><th>cost</th><th>time</th><th>cost-of-pass</th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan=6 class=vnote>no results</td></tr>'}</tbody>`
      + `</table>`;
  }
});
