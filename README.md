# usai · intellistudy

A **thin-shell** research dashboard for AI model/harness experiments. The shell does only two
things — and is never extended:

1. Renders a **canonical data layer** (experiments · results · discoveries · resources) from
   `public/data/state.json`.
2. Loads **agent-generated view-components** from `public/views/*.js`, listed in
   `public/views/manifest.json`, and hosts them.

There is no hardcoded analytics. You add a way to *see* something by generating a view — not by
editing the shell.

One codebase runs identically locally and in the cloud via **Cloudflare Workers Static Assets**.

```
public/
  index.html            # the thin shell (served at /)
  data/state.json       # canonical data — the only thing the shell reads
  views/manifest.json   # list of view files to load
  views/convergence.js  # generated view: convergence-vs-thrash signal
  views/results-table.js# generated view: cost-of-pass table
wrangler.toml           # assets-only Worker config
```

## Run locally (Docker — no Cloudflare login)

```bash
docker compose up --build
```

Open <http://localhost:8787>. The container runs `wrangler dev`, which uses Cloudflare's local
runtime (workerd) fully offline — the same runtime production uses, no account required.

`public/` is bind-mounted, so editing `data/state.json` or adding a view and reloading the page
takes effect without a rebuild.

Sanity checks:

```bash
curl -s localhost:8787/data/state.json
curl -s localhost:8787/views/manifest.json
```

You should see the top-right status read `data: live · views: 2` and both views render. (Opening
`public/index.html` as a bare file instead falls back to embedded sample data + inline example
views — that's expected with no server.)

### Without Docker

```bash
npm install
npm run dev          # wrangler dev on :8787
```

## Deploy to Cloudflare

```bash
npx wrangler login   # one-time, interactive
npm run deploy       # ships ./public to usai.<account>.workers.dev
```

## Adding a view (the contract)

To add a visualization, **generate a new view file** — do not edit `index.html`:

1. Write `public/views/<name>.js` that calls:
   ```js
   HUB.registerView({ id, title, group, render(data, el) { /* read data, draw into el */ } });
   ```
   `data` is the parsed `state.json`; `el` is the mount node for your view's card.
2. Add `"<name>.js"` to the `views` array in `public/views/manifest.json`.
3. Reload. To change what data is shown, edit `public/data/state.json`.

`convergence.js` and `results-table.js` are the reference examples.
