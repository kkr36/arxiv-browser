const PROXY_PREFIX = "/api/proxy-json?url=";

export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Parsed from a Retry-After header, when the server sent one (e.g. on 429). */
  retryAfterMs?: number;
}

/**
 * Fetches JSON from a URL, trying a direct cross-origin fetch first and
 * falling back to the local dev proxy if the host doesn't send CORS
 * headers. Pass `viaProxy: true` to skip the direct attempt — needed for
 * Semantic Scholar, where the API key lives server-side in the proxy and
 * 429 responses carry no CORS headers (so a direct attempt would just
 * double the traffic exactly when rate-limited). Mirrors fetchPdfBytes so
 * a future extension build can swap both for background-script fetches.
 */
export async function fetchJson<T>(
  url: string,
  opts?: { viaProxy?: boolean },
): Promise<JsonResponse<T>> {
  if (!opts?.viaProxy) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (res.status === 0) throw new Error("opaque response");
      return await toJsonResponse<T>(res);
    } catch {
      // fall through to the proxy
    }
  }
  const res = await fetch(`${PROXY_PREFIX}${encodeURIComponent(url)}`);
  return await toJsonResponse<T>(res);
}

async function toJsonResponse<T>(res: Response): Promise<JsonResponse<T>> {
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
  return {
    ok: res.ok,
    status: res.status,
    data: res.ok ? ((await res.json()) as T) : null,
    retryAfterMs,
  };
}
