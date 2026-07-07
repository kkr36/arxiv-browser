# arxiv-browser

A tool that allows you to open up the pdfs for papers in arXiv and other conference proceedings, and browse through the cited work.

## Usage

When you open up the pdf via this tool, all the in-line citations will be hover-able. If you are to click on them, they will take you to the pdf version of that citation; hovering over them gives you a preview of the cited article.

## Running it

```
npm install
npm run dev
```

Then open the printed local URL, and either:

- type an arXiv id (e.g. `1706.03762`), an arXiv `abs`/`pdf` URL, a direct PDF URL, a supported paper page URL, or a Google Scholar / Semantic Scholar author profile URL, and click **Load**, or
- click **Upload PDF** to browse a local file.

Once the PDF renders, citation markers (`[12]`, `[3, 4]`, `[Vas17]`, `(Smith et al., 2020)`, or narrative `Smith et al. (2020)` style) are highlighted. Hover one for a title/author/abstract preview (via Semantic Scholar); click one to open the cited paper's PDF in the viewer. If the usual APIs cannot find an open PDF, the tooltip and citations panel can run an explicit web PDF search and open a validated public PDF when one is found.

When Semantic Scholar metadata is available for the current paper, author names near the top of the PDF are highlighted too. Click an author to open their compiled works as an author node in the same viewer and exploration graph. Author pages list works from Semantic Scholar; pasted Google Scholar profile URLs are parsed best-effort and enriched with Semantic Scholar when a matching author can be found. Clicking a work opens its PDF when known, or offers the same public-PDF search fallback used for citations.

Supported paper pages include NBER working papers (`nber.org/papers/w34223`), NeurIPS/NIPS proceedings pages (`papers.nips.cc` / `papers.neurips.cc`), and best-effort IEEE Xplore document pages. IEEE downloads depend on access: public or IP-entitled PDFs may work directly; the Chrome extension also attempts credentialed requests using the browser session. For the local web app proxy, you can optionally put an IEEE cookie in `.env.local`:

```
IEEE_XPLORE_COOKIE=your-ieee-cookie-string
```

Keep that file local; the cookie is attached only by the dev server proxy and is never sent to client code.

The **Citations** button in the header opens a side panel listing every parsed reference for the current paper, with how many times each is cited in the text. Click an item to expand its full reference text; the `↗` button resolves and opens that paper, same as clicking an in-text marker.

## Sharing the exploration graph

The graph panel's **Export ▾** menu offers three ways to share a browsing session:

- **HTML page** — a single self-contained HTML file rendering the graph, with hover previews and links (no dependencies, works offline).
- **Obsidian vault (.zip)** — a folder of Markdown notes (one per paper/author, with YAML frontmatter and abstract) whose *Opened from* / *Led to* `[[wikilinks]]` reproduce the full exploration graph in Obsidian's graph view, plus a session index note and a JSON Canvas (`.canvas`) file preserving the panel layout (including nodes you dragged). Unzip it at your vault root.
- **Publish to Semble…** — pushes the session to [Semble](https://semble.so) (a social knowledge network on the AT Protocol) as a collection of URL cards in exploration order. Semble has no card-to-card edges, so graph structure degrades to provenance: each card's note records which paper it was opened from, and `viaCardId` points at the parent's card. Papers without any public URL are skipped and listed in the collection description. The Semble API is alpha, so per-card failures are reported but don't abort the publish.

  You need an API key from [semble.so/settings/api-keys](https://semble.so/settings/api-keys). The recommended way to provide it is `.env.local` (gitignored, next to `S2_API_KEY`):

  ```
  SEMBLE_API_KEY=your-semble-key
  ```

  Leave the dialog's key field blank and the dev-server proxy attaches the key server-side — it never reaches client code. Alternatively (and necessarily in the Chrome extension, which has no dev server), paste the key into the dialog; it is then sent as `X-API-Key` directly to `api.semble.so` (their `/xrpc` API serves open CORS) and, if you tick "Remember key", kept in your browser's localStorage.

Both file exports work identically in the web app and the Chrome extension; Semble publishing routes through the extension's background worker when running as an extension. For development there is a mock mode — set `localStorage["arxiv-browser:semble-mock"] = "1"` and the publish flow runs against a fake backend, logging calls to `window.__sembleMockCalls`.

## Chrome extension

This fork also builds a Manifest V3 Chrome extension:

```
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist/` directory.

Usage:

- open a direct PDF URL, such as an arXiv PDF, in Chrome
- click the **Paper Browser** extension button
- the current tab is replaced with the extension's pdf.js viewer, using the same citation parsing, hover previews, citations panel, and graph logic as the web app
- click an annotated in-text citation to load that cited PDF in the same tab; the newly loaded PDF is parsed and annotated too

The extension uses a background service worker for PDF, Semantic Scholar, OpenAlex, and fallback PDF-search requests, so it does not need the local Vite proxy to fetch cross-origin PDFs. The extension build currently uses Semantic Scholar's public API pool; `.env.local`/`S2_API_KEY` only applies to the local dev-server proxy.

### Semantic Scholar API key (optional but recommended)

The public Semantic Scholar pool is heavily rate-limited. With [an API key](https://www.semanticscholar.org/product/api#api-key), put it in `.env.local`:

```
S2_API_KEY=your-key-here
```

The dev-server proxy attaches it as `x-api-key` (it never reaches client code). All lookups run through a serialized queue spaced ~1.1 s apart to fit the 1 request/second key budget; 429s are retried with `Retry-After`/backoff and are never cached as failures — hovering again retries.

## How it works

- **PDF rendering**: [pdf.js](https://mozilla.github.io/pdf.js/) renders each page to a canvas with a transparent text layer on top.
- **Citation detection**: the extracted text is scanned for numbered (`[12]`), alphanumeric-label (`[Vas17]`), and author-year (`(Smith, 2020)`) markers, and the References/Bibliography section is split into individual entries using a hanging-indent heuristic (falls back to numbered/keyed prefixes), so markers can be matched to the entry they cite.
- **Resolution**: each cited entry's raw text is looked up via the [Semantic Scholar API](https://api.semanticscholar.org/) to get title/abstract/authors and, where available, a direct open-access PDF link (arXiv link used as a fallback when Semantic Scholar knows the arXiv id). A user-triggered PDF search endpoint can also check explicit reference URLs, OpenAlex open-access locations, and web-search PDF candidates.
- **Dev proxy**: `vite.config.ts` proxies PDF fetches and Semantic Scholar calls through the dev server, since neither reliably sends CORS headers for browser-origin requests.

## Architecture notes

The `src/core/` directory (PDF text extraction, citation detection/matching, Semantic Scholar client) has no framework or DOM-overlay dependencies beyond `fetch`, so it is shared by both the web app and the extension viewer. The browser-specific seam is `src/core/net/` plus `src/core/webPdfSearch.ts`: in local dev they use Vite proxy endpoints, while the extension build routes the same requests through `src/extension/background.ts`.

Citation, author, and author-work clicks resolve and open one item at a time inside the same viewer, preserving an in-app back/forward stack and the exploration graph.

### Known limitations

- Bibliography splitting is heuristic (indentation/numbering based) and can misfire on unusual reference-list layouts.
- Author-year citation matching handles `(Surname et al., Year)` groups and narrative `Surname et al. (Year)` forms, but lowercase particles (`van der Berg`) can still be missed.
- pdf.js text spans can overlap slightly; very small markers (a lone bracket at a line edge) are occasionally hard to hit with the mouse.
- The Semantic Scholar public API has a low unauthenticated rate limit; without an API key in `.env.local`, expect "rate-limiting" tooltips that succeed on re-hover.
