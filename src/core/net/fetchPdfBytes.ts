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
  let directError: unknown;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    directError = err;
  }

  let res: Response;
  try {
    res = await fetch(`${PROXY_PREFIX}${encodeURIComponent(url)}`);
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
  return await res.arrayBuffer();
}
