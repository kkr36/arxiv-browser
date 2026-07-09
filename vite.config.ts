import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  knownPaperUrlsFromText,
  maybeKnownPaperUrl,
  resolveKnownPaperPdfUrl,
} from "./src/core/pdfSources";
import { extractDoi } from "./src/core/metadata/identifiers";
import { MAILTO } from "./src/core/metadata/politeness";

const UPSTREAM_TIMEOUT_MS = 30_000;
const PDF_SEARCH_TIMEOUT_MS = 12_000;

interface PublicPdfSearchResult {
  pdfUrl: string;
  title?: string;
  source: "unpaywall" | "openalex" | "web-search" | "reference-url";
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
 *
 * If `OPENALEX_API_KEY` is set, it is appended as `api_key=` to OpenAlex
 * requests the same way — OpenAlex's free anonymous pool is metered at
 * $0.10/day (easy to exhaust with normal hover traffic), a free API key
 * raises that to $1/day. Kept server-side for the same reason: a key baked
 * into client code is readable by anyone and would let others draw down the
 * owner's daily budget.
 */
function jsonProxyPlugin(s2ApiKey?: string, openAlexApiKey?: string): Plugin {
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
          const targetUrl = new URL(target);
          if (s2ApiKey && targetUrl.hostname.endsWith("semanticscholar.org")) {
            headers["x-api-key"] = s2ApiKey;
          }
          if (openAlexApiKey && targetUrl.hostname.endsWith("openalex.org")) {
            targetUrl.searchParams.set("api_key", openAlexApiKey);
          }
          const upstream = await fetch(targetUrl, {
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

/**
 * Dev-only proxy for the Semble API (api.semble.so/xrpc). Semble's /xrpc
 * router does send CORS headers, so the browser *can* call it directly with a
 * user-entered key — this proxy exists so the key can instead live in
 * `.env.local` as `SEMBLE_API_KEY` and be attached server-side, never
 * reaching client code (same pattern as `S2_API_KEY` above). The publish
 * dialog uses it whenever its API-key field is left blank.
 */
function sembleProxyPlugin(sembleApiKey?: string): Plugin {
  return {
    name: "semble-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy-semble", async (req, res) => {
        if (!sembleApiKey?.trim()) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: "SEMBLE_API_KEY is not set in .env.local" }));
          return;
        }
        // req.url is the path after the mount point: "/<nsid>?<query>".
        const target = `https://api.semble.so/xrpc${req.url ?? ""}`;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const upstream = await fetch(target, {
            method: req.method,
            headers: {
              "X-API-Key": sembleApiKey.trim(),
              ...(body.length ? { "Content-Type": "application/json" } : {}),
            },
            body: body.length ? body : undefined,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          const retryAfter = upstream.headers.get("retry-after");
          if (retryAfter) res.setHeader("Retry-After", retryAfter);
          res.end(await upstream.text());
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ message: `Proxy could not reach ${target}: ${(err as Error).message}` }));
        }
      });
    },
  };
}

function publicPdfSearchPlugin(ieeeXploreCookie?: string, openAlexApiKey?: string): Plugin {
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
          const result = await findPublicPdfServer(title, rawText, ieeeXploreCookie, openAlexApiKey);
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
  openAlexApiKey?: string,
): Promise<PublicPdfSearchResult | null> {
  for (const url of [...knownPaperUrlsFromText(rawText), ...urlsFromReference(rawText)]) {
    const pdfUrl = await validatePdfUrl(url, ieeeXploreCookie);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "reference-url" };
  }

  const unpaywall = await findUnpaywallPdf(rawText, title, ieeeXploreCookie);
  if (unpaywall) return unpaywall;

  const openAlex = await findOpenAlexPdf(title || rawText, ieeeXploreCookie, openAlexApiKey);
  if (openAlex) return openAlex;

  const queryTitle = title || rawText.slice(0, 180);
  for (const url of await findWebPdfCandidates(queryTitle)) {
    const pdfUrl = await validatePdfUrl(url, ieeeXploreCookie);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "web-search" };
  }
  return null;
}

/** Unpaywall is DOI-keyed and the canonical open-access index, so when the
 * reference carries a DOI it beats searching by title. */
async function findUnpaywallPdf(
  rawText: string,
  title: string,
  ieeeXploreCookie?: string,
): Promise<PublicPdfSearchResult | null> {
  const doi = extractDoi(rawText);
  if (!doi) return null;
  const json = await fetchJsonServer<{
    is_oa?: boolean;
    best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null;
    oa_locations?: Array<{ url_for_pdf?: string | null; url?: string | null }> | null;
  }>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(MAILTO)}`);
  if (!json?.is_oa) return null;

  const locations = [json.best_oa_location, ...(json.oa_locations ?? [])];
  for (const candidate of unique(
    locations.flatMap((l) => [l?.url_for_pdf, l?.url]).filter((u): u is string => !!u),
  )) {
    const pdfUrl = await validatePdfUrl(candidate, ieeeXploreCookie);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "unpaywall" };
  }
  return null;
}

async function findOpenAlexPdf(
  query: string,
  ieeeXploreCookie?: string,
  openAlexApiKey?: string,
): Promise<PublicPdfSearchResult | null> {
  if (query.length < 8) return null;
  const url =
    "https://api.openalex.org/works?per-page=5&select=title,open_access,primary_location,locations&search=" +
    encodeURIComponent(query) +
    (openAlexApiKey ? `&api_key=${encodeURIComponent(openAlexApiKey)}` : "");
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
      jsonProxyPlugin(env.S2_API_KEY, env.OPENALEX_API_KEY),
      sembleProxyPlugin(env.SEMBLE_API_KEY),
      publicPdfSearchPlugin(env.IEEE_XPLORE_COOKIE, env.OPENALEX_API_KEY),
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
