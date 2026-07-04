---
name: verify
description: How to launch and drive arxiv-browser to verify changes end-to-end (Vite dev server + Playwright against the real UI).
---

# Verifying arxiv-browser

## Launch

```bash
npm run dev   # Vite on http://localhost:5173, includes /api/proxy-pdf and /api/proxy-json dev proxies
```

Both proxies are required — arXiv PDFs and the Semantic Scholar API don't send
CORS headers, so the app falls back to them. Console CORS errors for direct
`arxiv.org/pdf/...` fetches are expected noise (the proxy fallback follows).

## Drive (Playwright, chromium)

The playwright npm package is not a project dep — `npm install playwright` in a
scratch dir (browsers are already in `~/Library/Caches/ms-playwright`).

Key selectors / flows:
- Address bar: `.load-bar input:not([type=file])`; buttons: `Load`, `Upload PDF`,
  nav arrows by title `Back (Alt+←)` / `Forward (Alt+→)`.
- Load default paper (1706.03762): click `Load`, wait for `.status-line` with
  text `references parsed`.
- Citation markers are `.citation-mark` spans, grouped by `data-marker-id`
  (one marker is often split across pdf.js text items — a `[` sliver plus the
  digits). To click ref `[n]`: group span texts by marker id, pick the group
  whose digits equal `n`, click a digit-bearing span. Always
  `el.scrollIntoView({ block: "center" })` first — the sticky header
  intercepts clicks near the top.
- Markers/pages render progressively; after any navigation, wait for the
  target marker to exist before clicking (`page.waitForFunction`).
- To detect in-app navigation, wait for the address bar value to *change* —
  the old `references parsed` status line matches immediately and races.

## Gotchas

- Semantic Scholar rate-limits (429) the shared pool; lookups are queued at
  ~1.1s spacing and can transiently fail. Don't build assertions on a specific
  ref resolving — probe S2 first via
  `/api/proxy-json?url=<encoded S2 /paper/search/match URL>` to find refs whose
  records have an arXiv id (in the Attention paper, `[9]` → 1705.03122 works).
- Some refs genuinely have no open-access PDF (e.g. `[13]` LSTM) — clicking
  them shows the "No PDF found … Open on Semantic Scholar" header link, which
  is correct behavior, not a failure.
- Deterministic race probe (no S2): click a citation, then immediately type a
  different arXiv id in the address bar and press Enter — the later load must
  win and the cancelled one must not appear in history.
