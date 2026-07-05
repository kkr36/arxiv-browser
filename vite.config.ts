import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  knownPaperUrlsFromText,
  maybeKnownPaperUrl,
  resolveKnownPaperPdfUrl,
} from "./src/core/pdfSources";

const UPSTREAM_TIMEOUT_MS = 30_000;
const PDF_SEARCH_TIMEOUT_MS = 12_000;

interface PublicPdfSearchResult {
  pdfUrl: string;
  title?: string;
  source: "openalex" | "web-search" | "reference-url";
}

/**
 * Dev-only PDF proxy. Many hosts (arXiv included, inconsistently) don't send
 * CORS headers on PDF bytes, so the browser can't `fetch()` them directly.
 * This mirrors what a browser-extension background script would do (fetch
 * with host permissions, no CORS involved) so the core loading code can stay
 * identical between the web app and a future extension.
 *
 * Note: both proxies are open relays (`?url=` fetches anything). That is
 * fine for a local dev server but must never be deployed as-is.
 */
function pdfProxyPlugin(ieeeXploreCookie?: string): Plugin {
  return {
    name: "pdf-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy-pdf", async (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://localhost");
        const target = fullUrl.searchParams.get("url");
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url param");
          return;
        }
        try {
          let fetchUrl = resolveKnownPaperPdfUrl(target) ?? target;
          let upstream = await fetch(fetchUrl, {
            headers: proxyHeadersFor(fetchUrl, ieeeXploreCookie),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (upstream.ok && !isPdfResponse(upstream) && maybeKnownPaperUrl(fetchUrl)) {
            const resolved = await validatePdfUrl(fetchUrl, ieeeXploreCookie);
            if (resolved && resolved !== fetchUrl) {
              fetchUrl = resolved;
              upstream = await fetch(fetchUrl, {
                headers: proxyHeadersFor(fetchUrl, ieeeXploreCookie),
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
              });
            }
          }
          if (!upstream.ok || !upstream.body) {
            const detail = (await upstream.text().catch(() => "")).slice(0, 200);
            res.statusCode = upstream.status || 502;
            res.end(
              `Upstream ${fetchUrl} responded ${upstream.status} ${upstream.statusText}${detail ? `: ${detail}` : ""}`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            upstream.headers.get("content-type") ?? "application/pdf",
          );
          res.setHeader("Access-Control-Allow-Origin", "*");
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.end(buffer);
        } catch (err) {
          res.statusCode = 502;
          res.end(`Proxy could not reach ${target}: ${(err as Error).message}`);
        }
      });
    },
  };
}

/**
 * Dev-only JSON proxy for the Semantic Scholar API, which does not send
 * CORS headers for browser-origin requests (notably: none at all on 429
 * responses). Same rationale as the PDF proxy above: a browser extension's
 * background script would fetch this directly instead.
 *
 * If `S2_API_KEY` is set (e.g. in `.env.local`), it is attached as
 * `x-api-key` for Semantic Scholar requests — keeping the key out of
 * client-side code. `Retry-After` is forwarded so the client can pace
 * retries after a 429.
 */
function jsonProxyPlugin(s2ApiKey?: string): Plugin {
  return {
    name: "json-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy-json", async (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://localhost");
        const target = fullUrl.searchParams.get("url");
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url param");
          return;
        }
        try {
          const headers: Record<string, string> = {
            "User-Agent": "arxiv-browser/0.1 (+local dev proxy)",
          };
          if (s2ApiKey && new URL(target).hostname.endsWith("semanticscholar.org")) {
            headers["x-api-key"] = s2ApiKey;
          }
          const upstream = await fetch(target, {
            headers,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          const body = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          const retryAfter = upstream.headers.get("retry-after");
          if (retryAfter) res.setHeader("Retry-After", retryAfter);
          res.end(body);
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: `Proxy could not reach ${target}: ${(err as Error).message}` }));
        }
      });
    },
  };
}

function publicPdfSearchPlugin(ieeeXploreCookie?: string): Plugin {
  return {
    name: "public-pdf-search",
    configureServer(server) {
      server.middlewares.use("/api/find-public-pdf", async (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://localhost");
        const title = cleanText(fullUrl.searchParams.get("title") ?? "");
        const rawText = cleanText(fullUrl.searchParams.get("rawText") ?? "");
        if (!title && !rawText) {
          res.statusCode = 400;
          res.end("Missing title or rawText param");
          return;
        }

        try {
          const result = await findPublicPdfServer(title, rawText, ieeeXploreCookie);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
    },
  };
}

async function findPublicPdfServer(
  title: string,
  rawText: string,
  ieeeXploreCookie?: string,
): Promise<PublicPdfSearchResult | null> {
  for (const url of [...knownPaperUrlsFromText(rawText), ...urlsFromReference(rawText)]) {
    const pdfUrl = await validatePdfUrl(url, ieeeXploreCookie);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "reference-url" };
  }

  const openAlex = await findOpenAlexPdf(title || rawText, ieeeXploreCookie);
  if (openAlex) return openAlex;

  const queryTitle = title || rawText.slice(0, 180);
  for (const url of await findWebPdfCandidates(queryTitle)) {
    const pdfUrl = await validatePdfUrl(url, ieeeXploreCookie);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "web-search" };
  }
  return null;
}

async function findOpenAlexPdf(
  query: string,
  ieeeXploreCookie?: string,
): Promise<PublicPdfSearchResult | null> {
  if (query.length < 8) return null;
  const url =
    "https://api.openalex.org/works?per-page=5&select=title,open_access,primary_location,locations&search=" +
    encodeURIComponent(query);
  const json = await fetchJsonServer<{
    results?: Array<{
      title?: string;
      open_access?: { oa_url?: string | null };
      primary_location?: { pdf_url?: string | null; landing_page_url?: string | null };
      locations?: Array<{ pdf_url?: string | null; landing_page_url?: string | null }>;
    }>;
  }>(url);

  for (const work of json?.results ?? []) {
    const urls = [
      work.open_access?.oa_url,
      work.primary_location?.pdf_url,
      work.primary_location?.landing_page_url,
      ...(work.locations ?? []).flatMap((l) => [l.pdf_url, l.landing_page_url]),
    ].filter((u): u is string => !!u);
    for (const candidate of urls) {
      const pdfUrl = await validatePdfUrl(candidate, ieeeXploreCookie);
      if (pdfUrl) return { pdfUrl, title: work.title, source: "openalex" };
    }
  }
  return null;
}

async function findWebPdfCandidates(title: string): Promise<string[]> {
  if (title.length < 8) return [];
  const queries = [`"${title}" filetype:pdf`, `"${title}" pdf`];
  const candidates: string[] = [];
  for (const query of queries) {
    const html = await fetchTextServer(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    );
    if (!html) continue;
    for (const url of urlsFromHtml(html)) {
      if (looksPdfLike(url) || maybeKnownPaperUrl(url)) candidates.push(url);
      if (candidates.length >= 10) return unique(candidates);
    }
  }
  return unique(candidates);
}

async function validatePdfUrl(url: string, ieeeXploreCookie?: string): Promise<string | null> {
  const normalized = normalizeCandidateUrl(url);
  if (!normalized || !/^https?:\/\//i.test(normalized)) return null;
  const knownSourcePdf = resolveKnownPaperPdfUrl(normalized);
  if (knownSourcePdf && knownSourcePdf !== normalized) {
    return validatePdfUrl(knownSourcePdf, ieeeXploreCookie);
  }

  try {
    const head = await fetch(normalized, {
      method: "HEAD",
      redirect: "follow",
      headers: pdfFinderHeadersFor(normalized, ieeeXploreCookie),
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    if (isPdfResponse(head)) return head.url || normalized;
    const redirectedKnownSourcePdf = resolveKnownPaperPdfUrl(head.url);
    if (redirectedKnownSourcePdf && redirectedKnownSourcePdf !== normalized) {
      return validatePdfUrl(redirectedKnownSourcePdf, ieeeXploreCookie);
    }
  } catch {
    // Some hosts reject HEAD; try a tiny ranged GET below.
  }

  try {
    const get = await fetch(normalized, {
      redirect: "follow",
      headers: {
        ...pdfFinderHeadersFor(normalized, ieeeXploreCookie),
        Range: "bytes=0-4",
      },
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    if (!get.ok) return null;
    if (isPdfResponse(get)) return get.url || normalized;
    const redirectedKnownSourcePdf = resolveKnownPaperPdfUrl(get.url);
    if (redirectedKnownSourcePdf && redirectedKnownSourcePdf !== normalized) {
      return validatePdfUrl(redirectedKnownSourcePdf, ieeeXploreCookie);
    }
    const bytes = new Uint8Array(await get.arrayBuffer());
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    ) {
      return get.url || normalized;
    }
  } catch {
    return null;
  }
  return null;
}

function isPdfResponse(res: Response): boolean {
  if (!res.ok) return false;
  const type = res.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("application/pdf") || looksPdfLike(res.url);
}

async function fetchJsonServer<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "arxiv-browser/0.1 (+local PDF finder)" },
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function fetchTextServer(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "arxiv-browser/0.1 (+local PDF finder)" },
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function urlsFromReference(rawText: string): string[] {
  return unique(
    [...rawText.matchAll(/https?:\/\/[^\s"<>]+/gi)]
      .map((m) => m[0].replace(/[.,;)\]]+$/, ""))
      .filter((url) => looksPdfLike(url) || maybeKnownPaperUrl(url)),
  );
}

function urlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/href=(["'])(.*?)\1/gi)) {
    const decoded = decodeHtml(match[2]);
    const resolved = normalizeDuckDuckGoUrl(decoded);
    if (resolved) urls.push(resolved);
  }
  return unique(urls);
}

function normalizeDuckDuckGoUrl(url: string): string | null {
  if (url.startsWith("//")) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) {
    const parsed = safeUrl(url);
    const redirected = parsed?.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url;
  }
  const parsed = safeUrl(url, "https://duckduckgo.com");
  const redirected = parsed?.searchParams.get("uddg");
  return redirected ? decodeURIComponent(redirected) : null;
}

function normalizeCandidateUrl(url: string): string | null {
  const decoded = decodeHtml(url.trim());
  const parsed = safeUrl(decoded);
  if (!parsed) return null;
  parsed.hash = "";
  return parsed.toString();
}

function looksPdfLike(url: string): boolean {
  return /\.pdf(?:[?#]|$)/i.test(url) || /\/pdf(?:\/|\?|$)/i.test(url);
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 500);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function safeUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function proxyHeadersFor(url: string, ieeeXploreCookie?: string): Record<string, string> {
  return withIeeeCookie(
    { "User-Agent": "arxiv-browser/0.1 (+local dev proxy)" },
    url,
    ieeeXploreCookie,
  );
}

function pdfFinderHeadersFor(url: string, ieeeXploreCookie?: string): Record<string, string> {
  return withIeeeCookie(
    { "User-Agent": "arxiv-browser/0.1 (+local PDF finder)" },
    url,
    ieeeXploreCookie,
  );
}

function withIeeeCookie(
  headers: Record<string, string>,
  url: string,
  ieeeXploreCookie?: string,
): Record<string, string> {
  const host = safeUrl(url)?.hostname.toLowerCase();
  if (ieeeXploreCookie?.trim() && host === "ieeexplore.ieee.org") {
    return { ...headers, Cookie: ieeeXploreCookie.trim() };
  }
  return headers;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      pdfProxyPlugin(env.IEEE_XPLORE_COOKIE),
      jsonProxyPlugin(env.S2_API_KEY),
      publicPdfSearchPlugin(env.IEEE_XPLORE_COOKIE),
    ],
    build: {
      rollupOptions: {
        input: {
          app: "index.html",
          "extension-viewer": "extension-viewer.html",
          background: "src/extension/background.ts",
        },
        output: {
          entryFileNames: "assets/[name].js",
          chunkFileNames: "assets/[name].js",
          assetFileNames: "assets/[name].[ext]",
        },
      },
    },
  };
});
