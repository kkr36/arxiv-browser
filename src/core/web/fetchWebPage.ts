import { fetchText } from "../net/fetchJson";

/**
 * Readable extract of a non-PDF web page (corporate newsroom posts, project
 * pages, reports cited by URL). Some references simply aren't papers; this
 * lets them render in-app instead of failing the PDF pipeline. Extraction is
 * regex-based on purpose — it runs identically in the web app, the extension,
 * and node tests, and sites that block framing (X-Frame-Options) still can't
 * stop a plain fetch.
 */
export interface WebPageBlock {
  kind: "heading" | "text";
  text: string;
}

export interface WebPageContent {
  url: string;
  title?: string;
  siteName?: string;
  description?: string;
  blocks: WebPageBlock[];
}

export async function fetchWebPageContent(url: string): Promise<WebPageContent> {
  const html = await fetchText(url);
  if (!html) throw new Error(`Could not fetch the page at ${url}.`);
  return extractReadableContent(url, html);
}

export function extractReadableContent(url: string, html: string): WebPageContent {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  const title =
    decodeEntities(cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim() ||
    metaContent(cleaned, "og:title") ||
    undefined;
  const siteName = metaContent(cleaned, "og:site_name");
  const description = metaContent(cleaned, "og:description") ?? metaContent(cleaned, "description");

  const blocks: WebPageBlock[] = [];
  const seen = new Set<string>();
  const blockRe = /<(h[1-6]|p|li|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) && blocks.length < 200) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (!text || seen.has(text)) continue;
    const isHeading = /^h/i.test(m[1]);
    // Short non-heading fragments are almost always nav/footer chrome.
    if (!isHeading && text.length < 40 && !/[.!?…]$/.test(text)) continue;
    if (isHeading && text.length < 3) continue;
    seen.add(text);
    blocks.push({ kind: isHeading ? "heading" : "text", text });
  }

  return { url, title, siteName, description, blocks };
}

function metaContent(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const value = decodeEntities(html.match(re)?.[1] ?? "").trim();
    if (value) return value;
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
