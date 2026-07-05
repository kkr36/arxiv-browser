import { hasExtensionRuntime, sendExtensionRequest } from "../../extension/runtimeBridge";
import { findPublicPdf } from "../webPdfSearch";
import { maybeKnownPaperUrl, resolveKnownPaperPdfUrl } from "../pdfSources";

const PROXY_PREFIX = "/api/proxy-pdf?url=";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches raw PDF bytes for a URL. Tries a direct cross-origin fetch first
 * (works when the host sends CORS headers), and falls back to the local dev
 * proxy otherwise. A browser-extension build would swap this one function
 * for a background-script fetch (which isn't subject to CORS given host
 * permissions) — nothing else in the app needs to change.
 */
export async function fetchPdfBytes(url: string): Promise<ArrayBuffer> {
  const fetchUrl = resolveKnownPaperPdfUrl(url) ?? url;

  if (hasExtensionRuntime()) {
    const response = await sendExtensionRequest({ type: "fetch-pdf", url: fetchUrl });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== "pdf") throw new Error("Extension returned the wrong response type.");
    return base64ToArrayBuffer(response.bytesBase64);
  }

  let directError: unknown;
  try {
    const res = await fetch(fetchUrl, { mode: "cors", credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (isPdfBytes(bytes)) return bytes;
    const resolved = await resolveKnownSourceViaSearch(fetchUrl);
    if (resolved) return fetchPdfBytes(resolved);
    throw new Error("Response was not a PDF");
  } catch (err) {
    directError = err;
  }

  let res: Response;
  try {
    res = await fetch(`${PROXY_PREFIX}${encodeURIComponent(fetchUrl)}`);
  } catch (err) {
    throw new Error(
      `Could not fetch PDF: direct fetch failed (${messageOf(directError)}) ` +
        `and the dev-server proxy was unreachable (${messageOf(err)}). ` +
        `Is \`npm run dev\` still running?`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Could not fetch PDF via proxy (HTTP ${res.status}${detail ? `: ${detail}` : ""})`,
    );
  }
  const bytes = await res.arrayBuffer();
  if (isPdfBytes(bytes)) return bytes;
  const resolved = await resolveKnownSourceViaSearch(fetchUrl);
  if (resolved) return fetchPdfBytes(resolved);
  throw new Error("Could not fetch PDF via proxy: upstream response was not a PDF.");
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function isPdfBytes(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function resolveKnownSourceViaSearch(url: string): Promise<string | null> {
  if (!maybeKnownPaperUrl(url)) return null;
  try {
    const result = await findPublicPdf({ rawText: url });
    return result?.pdfUrl && result.pdfUrl !== url ? result.pdfUrl : null;
  } catch {
    return null;
  }
}
