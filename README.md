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

- type an arXiv id (e.g. `1706.03762`), an arXiv `abs`/`pdf` URL, or any direct PDF URL, and click **Load**, or
- click **Upload PDF** to browse a local file.

Once the PDF renders, citation markers (`[12]`, `[3, 4]`, `(Smith et al., 2020)`, or narrative `Smith et al. (2020)` style) are highlighted. Hover one for a title/author/abstract preview (via Semantic Scholar); click one to open the cited paper's PDF in a new tab (falls back to its Semantic Scholar page if no open-access PDF is available).

The **Citations** button in the header opens a side panel listing every parsed reference for the current paper, with how many times each is cited in the text. Click an item to expand its full reference text; the `↗` button resolves and opens that paper, same as clicking an in-text marker.

### Semantic Scholar API key (optional but recommended)

The public Semantic Scholar pool is heavily rate-limited. With [an API key](https://www.semanticscholar.org/product/api#api-key), put it in `.env.local`:

```
S2_API_KEY=your-key-here
```

The dev-server proxy attaches it as `x-api-key` (it never reaches client code). All lookups run through a serialized queue spaced ~1.1 s apart to fit the 1 request/second key budget; 429s are retried with `Retry-After`/backoff and are never cached as failures — hovering again retries.

## How it works

- **PDF rendering**: [pdf.js](https://mozilla.github.io/pdf.js/) renders each page to a canvas with a transparent text layer on top.
- **Citation detection**: the extracted text is scanned for numbered (`[12]`) and author-year (`(Smith, 2020)`) markers, and the References/Bibliography section is split into individual entries using a hanging-indent heuristic (falls back to numbered prefixes), so markers can be matched to the entry they cite.
- **Resolution**: each cited entry's raw text is looked up via the [Semantic Scholar API](https://api.semanticscholar.org/) to get title/abstract/authors and, where available, a direct open-access PDF link (arXiv link used as a fallback when Semantic Scholar knows the arXiv id).
- **Dev proxy**: `vite.config.ts` proxies PDF fetches and Semantic Scholar calls through the dev server, since neither reliably sends CORS headers for browser-origin requests.

## Architecture notes

The `src/core/` directory (PDF text extraction, citation detection/matching, Semantic Scholar client) has no framework or DOM-overlay dependencies beyond `fetch` — it's meant to be reusable from a future browser-extension content script, not just this web app. The one browser/extension-specific seam is `src/core/net/` (`fetchPdfBytes`, `fetchJson`), which currently proxies through the dev server but would instead call out from an extension's background script (no CORS issue there, given host permissions).

The current version resolves and opens one citation at a time in a new tab. A likely next step is letting a click load the cited paper into the same viewer (keeping a back/forward stack across the citation graph) instead of opening a new tab — the citation service and viewer are already split so that should mostly be a change to the click handler in `src/viewer/PdfViewer.tsx`.

### Known limitations

- Bibliography splitting is heuristic (indentation/numbering based) and can misfire on unusual reference-list layouts.
- Author-year citation matching handles `(Surname et al., Year)` groups and narrative `Surname et al. (Year)` forms, but not lowercase particles (`van der Berg`) or alphanumeric keys like `[Vas17]`.
- pdf.js text spans can overlap slightly; very small markers (a lone bracket at a line edge) are occasionally hard to hit with the mouse.
- The Semantic Scholar public API has a low unauthenticated rate limit; without an API key in `.env.local`, expect "rate-limiting" tooltips that succeed on re-hover.
