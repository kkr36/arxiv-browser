import type { ExtensionRequest, ExtensionResponse } from "./runtimeBridge";
import type { JsonResponse } from "../core/net/fetchJson";
import type { PublicPdfSearchRequest, PublicPdfSearchResult } from "../core/webPdfSearch";
import {
  knownPaperUrlsFromText,
  maybeKnownPaperUrl,
  resolveKnownPaperPdfUrl,
} from "../core/pdfSources";
import { extractDoi } from "../core/metadata/identifiers";
import { MAILTO } from "../core/metadata/politeness";
import { titlesRoughlyEqual } from "../core/metadata/titleMatch";

const UPSTREAM_TIMEOUT_MS = 30_000;
const PDF_SEARCH_TIMEOUT_MS = 12_000;
const PENDING_ROOT_KEY = "pendingRootRequest";
const OPENALEX_API_KEY_KEY = "openAlexApiKey";
const S2_API_KEY_KEY = "semanticScholarApiKey";
let openAlexApiKey: string | null = null;
let s2ApiKey: string | null = null;

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url) return;
  const sourceUrl = sourceUrlFromTab(tab.url);
  void openOrQueueInViewer(tab, sourceUrl);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: messageOf(err) } satisfies ExtensionResponse));
  return true;
});

chrome.storage.local.get([OPENALEX_API_KEY_KEY, S2_API_KEY_KEY]).then((items) => {
  openAlexApiKey = stringValue(items[OPENALEX_API_KEY_KEY]);
  s2ApiKey = stringValue(items[S2_API_KEY_KEY]);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[OPENALEX_API_KEY_KEY]) {
    openAlexApiKey = stringValue(changes[OPENALEX_API_KEY_KEY].newValue);
  }
  if (changes[S2_API_KEY_KEY]) {
    s2ApiKey = stringValue(changes[S2_API_KEY_KEY].newValue);
  }
});

async function handleMessage(message: unknown): Promise<ExtensionResponse> {
  if (!isExtensionRequest(message)) {
    return { ok: false, error: "Unknown extension request." };
  }

  switch (message.type) {
    case "fetch-pdf":
      return {
        ok: true,
        type: "pdf",
        bytesBase64: arrayBufferToBase64(await fetchPdfBytes(message.url)),
      };
    case "fetch-json":
      return { ok: true, type: "json", response: await fetchJsonBackground(message.url) };
    case "fetch-text":
      return { ok: true, type: "text", text: await fetchTextBackground(message.url) };
    case "find-public-pdf":
      return { ok: true, type: "public-pdf", result: await findPublicPdfBackground(message.request) };
    case "http-request":
      return await httpRequestBackground(message);
  }
}

async function openOrQueueInViewer(tab: chrome.tabs.Tab, sourceUrl: string): Promise<void> {
  const viewer = await findExistingViewerTab(tab.id);
  if (viewer?.id) {
    await chrome.storage.local.set({
      [PENDING_ROOT_KEY]: { id: Date.now(), input: sourceUrl },
    });
    if (viewer.windowId !== undefined) {
      await chrome.windows.update(viewer.windowId, { focused: true });
    }
    await chrome.tabs.update(viewer.id, { active: true });
    return;
  }

  if (!tab.id) return;
  await chrome.storage.local.remove(PENDING_ROOT_KEY);
  const viewerUrl = chrome.runtime.getURL(
    `extension-viewer.html?url=${encodeURIComponent(sourceUrl)}`,
  );
  await chrome.tabs.update(tab.id, { url: viewerUrl });
}

async function findExistingViewerTab(currentTabId?: number): Promise<chrome.tabs.Tab | null> {
  const viewerUrl = chrome.runtime.getURL("extension-viewer.html");
  const tabs = await chrome.tabs.query({ url: `${viewerUrl}*` });
  return tabs.find((tab) => tab.id !== currentTabId) ?? tabs[0] ?? null;
}

// The http-request relay forwards arbitrary headers (API keys), so unlike the
// GET-only fetchers it is limited to hosts that actually need it.
const HTTP_REQUEST_ALLOWED_HOSTS = new Set(["api.semble.so"]);

async function httpRequestBackground(request: {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<ExtensionResponse> {
  const host = new URL(request.url).hostname;
  if (!HTTP_REQUEST_ALLOWED_HOSTS.has(host)) {
    return { ok: false, error: `Host ${host} is not allowed for http-request.` };
  }
  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  return { ok: true, type: "http", status: res.status, bodyText: await res.text(), retryAfterMs };
}

function sourceUrlFromTab(tabUrl: string): string {
  try {
    const url = new URL(tabUrl);
    if (url.protocol === "chrome-extension:" && url.pathname.endsWith("/extension-viewer.html")) {
      return url.searchParams.get("url") ?? tabUrl;
    }
  } catch {
    // Keep the raw tab URL below.
  }
  return tabUrl;
}

async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
  const fetchUrl = resolveKnownPaperPdfUrl(url) ?? url;
  const res = await fetch(fetchUrl, {
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Could not fetch PDF (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
  }
  const bytes = await res.arrayBuffer();
  if (isPdfBytes(bytes)) return bytes;

  const resolved = maybeKnownPaperUrl(fetchUrl) ? await validatePdfUrl(fetchUrl) : null;
  if (resolved && resolved !== fetchUrl) return fetchPdfBytes(resolved);
  throw new Error("Could not fetch PDF: upstream response was not a PDF.");
}

async function fetchJsonBackground<T>(url: string): Promise<JsonResponse<T>> {
  const request = await withMetadataApiAuth(url);
  const res = await fetch(request.url, {
    headers: request.headers,
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  return {
    ok: res.ok,
    status: res.status,
    data: res.ok ? ((await res.json()) as T) : null,
    retryAfterMs,
  };
}

async function fetchTextBackground(url: string): Promise<string | null> {
  try {
    const request = await withMetadataApiAuth(url);
    const res = await fetch(request.url, {
      headers: request.headers,
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function withMetadataApiAuth(
  url: string,
): Promise<{ url: string; headers?: Record<string, string> }> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("openalex.org")) {
      const key = openAlexApiKey ?? (await readStoredApiKeys()).openAlex;
      if (key) parsed.searchParams.set("api_key", key);
      return { url: parsed.toString() };
    }
    if (parsed.hostname.endsWith("semanticscholar.org")) {
      const key = s2ApiKey ?? (await readStoredApiKeys()).s2;
      return key ? { url, headers: { "x-api-key": key } } : { url };
    }
  } catch {
    // Keep the original URL below.
  }
  return { url };
}

async function readStoredApiKeys(): Promise<{ openAlex: string | null; s2: string | null }> {
  const items = await chrome.storage.local.get([OPENALEX_API_KEY_KEY, S2_API_KEY_KEY]);
  openAlexApiKey = stringValue(items[OPENALEX_API_KEY_KEY]);
  s2ApiKey = stringValue(items[S2_API_KEY_KEY]);
  return { openAlex: openAlexApiKey, s2: s2ApiKey };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function findPublicPdfBackground(
  request: PublicPdfSearchRequest,
): Promise<PublicPdfSearchResult | null> {
  const title = cleanText(request.title ?? "");
  const rawText = cleanText(request.rawText);

  for (const url of [...knownPaperUrlsFromText(rawText), ...urlsFromReference(rawText)]) {
    const pdfUrl = await validatePdfUrl(url);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "reference-url" };
  }

  const unpaywall = await findUnpaywallPdf(rawText, title);
  if (unpaywall) return unpaywall;

  const openAlex = await findOpenAlexPdf(title || rawText, title);
  if (openAlex) return openAlex;

  const queryTitle = title || rawText.slice(0, 180);
  for (const url of await findWebPdfCandidates(queryTitle)) {
    const pdfUrl = await validatePdfUrl(url);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "web-search" };
  }
  return null;
}

/** Unpaywall is DOI-keyed and the canonical open-access index, so when the
 * reference carries a DOI it beats searching by title. */
async function findUnpaywallPdf(
  rawText: string,
  title: string,
): Promise<PublicPdfSearchResult | null> {
  const doi = extractDoi(rawText);
  if (!doi) return null;
  const json = await fetchJsonBackground<{
    is_oa?: boolean;
    best_oa_location?: { url_for_pdf?: string | null; url?: string | null } | null;
    oa_locations?: Array<{ url_for_pdf?: string | null; url?: string | null }> | null;
  }>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(MAILTO)}`);
  if (!json.data?.is_oa) return null;

  const locations = [json.data.best_oa_location, ...(json.data.oa_locations ?? [])];
  for (const candidate of unique(
    locations.flatMap((l) => [l?.url_for_pdf, l?.url]).filter((u): u is string => !!u),
  )) {
    const pdfUrl = await validatePdfUrl(candidate);
    if (pdfUrl) return { pdfUrl, title: title || undefined, source: "unpaywall" };
  }
  return null;
}

async function findOpenAlexPdf(
  query: string,
  wantedTitle: string,
): Promise<PublicPdfSearchResult | null> {
  if (query.length < 8) return null;
  const url =
    "https://api.openalex.org/works?per-page=5&select=title,open_access,primary_location,locations&search=" +
    encodeURIComponent(query);
  const json = await fetchJsonBackground<{
    results?: Array<{
      title?: string;
      open_access?: { oa_url?: string | null };
      primary_location?: { pdf_url?: string | null; landing_page_url?: string | null };
      locations?: Array<{ pdf_url?: string | null; landing_page_url?: string | null }>;
    }>;
  }>(url);

  for (const work of json.data?.results ?? []) {
    // OpenAlex relevance search always returns *something*; without a title
    // check the first hit with any PDF wins and an unrelated paper renders.
    if (wantedTitle && !(work.title && titlesRoughlyEqual(work.title, wantedTitle))) continue;
    const urls = [
      work.open_access?.oa_url,
      work.primary_location?.pdf_url,
      work.primary_location?.landing_page_url,
      ...(work.locations ?? []).flatMap((location) => [
        location.pdf_url,
        location.landing_page_url,
      ]),
    ].filter((candidate): candidate is string => !!candidate);
    for (const candidate of urls) {
      const pdfUrl = await validatePdfUrl(candidate);
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
    const html = await fetchTextBackground(
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

async function validatePdfUrl(url: string): Promise<string | null> {
  const normalized = normalizeCandidateUrl(url);
  if (!normalized || !/^https?:\/\//i.test(normalized)) return null;
  const knownSourcePdf = resolveKnownPaperPdfUrl(normalized);
  if (knownSourcePdf && knownSourcePdf !== normalized) return validatePdfUrl(knownSourcePdf);

  try {
    const head = await fetch(normalized, {
      method: "HEAD",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    if (isPdfResponse(head)) return head.url || normalized;
    const redirectedKnownSourcePdf = resolveKnownPaperPdfUrl(head.url);
    if (redirectedKnownSourcePdf && redirectedKnownSourcePdf !== normalized) {
      return validatePdfUrl(redirectedKnownSourcePdf);
    }
  } catch {
    // Some hosts reject HEAD; try a tiny ranged GET below.
  }

  try {
    const get = await fetch(normalized, {
      credentials: "include",
      redirect: "follow",
      headers: { Range: "bytes=0-4" },
      signal: AbortSignal.timeout(PDF_SEARCH_TIMEOUT_MS),
    });
    if (!get.ok) return null;
    if (isPdfResponse(get)) return get.url || normalized;
    const redirectedKnownSourcePdf = resolveKnownPaperPdfUrl(get.url);
    if (redirectedKnownSourcePdf && redirectedKnownSourcePdf !== normalized) {
      return validatePdfUrl(redirectedKnownSourcePdf);
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

function urlsFromReference(rawText: string): string[] {
  return unique(
    [...rawText.matchAll(/https?:\/\/[^\s"<>]+/gi)]
      .map((match) => match[0].replace(/[.,;)\]]+$/, ""))
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

function isExtensionRequest(message: unknown): message is ExtensionRequest {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === "fetch-pdf" ||
    type === "fetch-json" ||
    type === "fetch-text" ||
    type === "find-public-pdf" ||
    type === "http-request"
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function isPdfBytes(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
