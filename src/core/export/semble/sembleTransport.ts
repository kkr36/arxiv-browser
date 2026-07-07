import { hasExtensionRuntime, sendExtensionRequest } from "../../../extension/runtimeBridge";
import {
  SEMBLE_API_BASE,
  SEMBLE_AUTH_HEADER,
  type SembleHttpResponse,
  type SembleTransport,
} from "./sembleClient";

const MOCK_KEY = "arxiv-browser:semble-mock";

/**
 * Picks the transport for the current context:
 * - mock, when `arxiv-browser:semble-mock` is "1" in localStorage — lets the
 *   publish flow run end-to-end with no key or network (used by verification);
 * - the background-worker relay inside the extension;
 * - direct fetch otherwise (Semble's /xrpc router serves open CORS).
 */
export function resolveSembleTransport(): SembleTransport {
  try {
    if (localStorage.getItem(MOCK_KEY) === "1") return createMockTransport();
  } catch {
    // localStorage unavailable: fall through to a real transport.
  }
  return hasExtensionRuntime() ? extensionTransport : fetchTransport;
}

function endpointUrl(nsid: string, query?: Record<string, string>): string {
  const params = query ? `?${new URLSearchParams(query)}` : "";
  return `${SEMBLE_API_BASE}/${nsid}${params}`;
}

const fetchTransport: SembleTransport = async (nsid, init) => {
  // With a key, call the API directly (its /xrpc router serves open CORS).
  // Without one, go through the dev proxy, which attaches SEMBLE_API_KEY
  // from .env.local server-side so the key never reaches client code.
  const viaProxy = !init.apiKey;
  const params = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const res = await fetch(viaProxy ? `/api/proxy-semble/${nsid}${params}` : endpointUrl(nsid, init.query), {
    method: init.method,
    headers: {
      ...(viaProxy ? {} : { [SEMBLE_AUTH_HEADER]: init.apiKey }),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    mode: "cors",
  });
  const retryAfter = res.headers.get("retry-after");
  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => null),
    retryAfterMs: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined,
  };
};

const extensionTransport: SembleTransport = async (nsid, init) => {
  const response = await sendExtensionRequest({
    type: "http-request",
    url: endpointUrl(nsid, init.query),
    method: init.method,
    headers: {
      [SEMBLE_AUTH_HEADER]: init.apiKey,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new Error(response.error);
  if (response.type !== "http") throw new Error("Extension returned the wrong response type.");
  let data: unknown = null;
  try {
    data = JSON.parse(response.bodyText);
  } catch {
    // Non-JSON body (e.g. an HTML error page): keep null.
  }
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    retryAfterMs: response.retryAfterMs,
  };
};

export interface MockCall {
  nsid: string;
  method: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string>;
}

declare global {
  interface Window {
    /** Call log of the mock Semble transport, for tests. */
    __sembleMockCalls?: MockCall[];
  }
}

/** Fake Semble backend: deterministic ids, every call logged on window.__sembleMockCalls. */
export function createMockTransport(): SembleTransport {
  let nextId = 1;
  return async (nsid, init): Promise<SembleHttpResponse> => {
    if (typeof window !== "undefined") {
      (window.__sembleMockCalls ??= []).push({
        nsid,
        method: init.method,
        body: init.body,
        query: init.query,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    switch (nsid) {
      case "network.cosmik.collection.create":
        return { ok: true, status: 200, data: { collectionId: `mock-collection-${nextId++}` } };
      case "network.cosmik.card.addUrl":
        return { ok: true, status: 200, data: { urlCardId: `mock-card-${nextId++}` } };
      case "network.cosmik.collection.get":
        return {
          ok: true,
          status: 200,
          data: {
            id: init.query?.collectionId,
            uri: `at://did:mock/network.cosmik.collection/mockrkey`,
            author: { handle: "mock.semble.so" },
          },
        };
      default:
        return { ok: false, status: 404, data: { message: `Mock: unknown endpoint ${nsid}` } };
    }
  };
}
