// A generated view-component. The agent writes files like this into views/ and
// adds them to views/manifest.json. It reads canonical data, renders a visual.
// Contract: call HUB.registerView({ id, title, group, render(data, el) }).
HUB.registerView({
  id: 'convergence',
  title: 'Convergence vs thrash',
  group: 'signal',
  render(data, el) {
    const cv = document.createElement('canvas');
    cv.style.width = '100%'; cv.style.height = '150px';
    el.appendChild(cv);
    const note = document.createElement('div');
    const passes = (data.results || []).filter(r => r.outcome === 'pass').length;
    note.className = 'vnote';
    note.textContent = `${passes} passing runs · teal converges to target, vermilion never settles`;
    el.appendChild(note);
    requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 400, H = 150;
      cv.width = W * dpr; cv.height = H * dpr;
      const c = cv.getContext('2d'); c.scale(dpr, dpr);
      const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      let t = 0;
      function path(seed, amp, decay, color, target) {
        c.beginPath();
        for (let x = 0; x <= W; x++) {
          const p = x / W, noise = Math.sin(x*0.18+seed) + Math.sin(x*0.07+seed*2);
          const env = amp * Math.exp(-decay*p) * (1 - p*0.2);
          const y = target + noise*env*(1+Math.sin(t*0.02+seed)*0.15);
          x === 0 ? c.moveTo(x,y) : c.lineTo(x,y);
        }
        c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
      }
      (function frame(){
        c.clearRect(0,0,W,H);
        c.strokeStyle='rgba(255,255,255,.06)'; c.setLineDash([3,4]);
        c.beginPath(); c.moveTo(0,H*0.5); c.lineTo(W,H*0.5); c.stroke(); c.setLineDash([]);
        path(1.2,24,2.6,css('--converge')||'#5FB3A3',H*0.5);
        path(4.7,18,0.2,css('--thrash')||'#D8694B',H*0.42);
        t++; requestAnimationFrame(frame);
      })();
    });
  }
});
