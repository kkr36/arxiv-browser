/**
 * Minimal client for the Semble alpha API (docs.cosmik.network/semble-api).
 * Endpoints are ATProto-style NSID paths under /xrpc; auth is the user's API
 * key (created at semble.so/settings/api-keys) in the X-API-Key header. The
 * /xrpc router serves open CORS, so browsers can call it directly.
 *
 * Endpoint shapes verified against cosmik-network/semble
 * (src/types/src/api/{cards/addUrl,collections/create,collections/get}.ts).
 */

export const SEMBLE_API_BASE = "https://api.semble.so/xrpc";
export const SEMBLE_APP_URL = "https://semble.so";
export const SEMBLE_AUTH_HEADER = "X-API-Key";

export interface SembleHttpResponse {
  ok: boolean;
  status: number;
  data: unknown;
  retryAfterMs?: number;
}

/** One HTTP call to a Semble XRPC endpoint; swappable for the extension relay or a mock. */
export type SembleTransport = (
  nsid: string,
  init: { method: "GET" | "POST"; apiKey: string; body?: unknown; query?: Record<string, string> },
) => Promise<SembleHttpResponse>;

export class SembleApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SembleApiError";
  }
}

export interface SembleClient {
  createCollection(input: {
    name: string;
    description?: string;
    accessType?: "OPEN" | "CLOSED";
  }): Promise<{ collectionId: string }>;
  addUrlCard(input: {
    url: string;
    note?: string;
    collectionIds?: string[];
    viaCardId?: string;
  }): Promise<{ urlCardId: string }>;
  /** Public page URL for a collection, or undefined when it can't be resolved. */
  getCollectionPageUrl(collectionId: string): Promise<string | undefined>;
}

export function createSembleClient(apiKey: string, transport: SembleTransport): SembleClient {
  const call = async (
    nsid: string,
    init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> },
  ): Promise<unknown> => {
    const res = await transport(nsid, { ...init, apiKey });
    if (!res.ok) {
      throw new SembleApiError(errorMessage(res), res.status, res.retryAfterMs);
    }
    return res.data;
  };

  return {
    async createCollection(input) {
      const data = await call("network.cosmik.collection.create", { method: "POST", body: input });
      const collectionId = stringField(data, "collectionId") ?? stringField(data, "id");
      if (!collectionId) throw new SembleApiError("Collection created but no id returned.", 200);
      return { collectionId };
    },

    async addUrlCard(input) {
      const data = await call("network.cosmik.card.addUrl", { method: "POST", body: input });
      const urlCardId = stringField(data, "urlCardId") ?? stringField(data, "cardId");
      if (!urlCardId) throw new SembleApiError("Card created but no id returned.", 200);
      return { urlCardId };
    },

    async getCollectionPageUrl(collectionId) {
      try {
        const data = await call("network.cosmik.collection.get", {
          method: "GET",
          query: { collectionId },
        });
        // Page URL is /profile/<author handle>/collections/<rkey of the AT URI>.
        const record = data as { uri?: unknown; author?: { handle?: unknown } };
        const uri = typeof record?.uri === "string" ? record.uri : undefined;
        const handle = typeof record?.author?.handle === "string" ? record.author.handle : undefined;
        const rkey = uri?.split("/").pop();
        if (handle && rkey) return `${SEMBLE_APP_URL}/profile/${handle}/collections/${rkey}`;
      } catch {
        // Best-effort: the publish already succeeded, a missing link is not an error.
      }
      return undefined;
    },
  };
}

function stringField(data: unknown, key: string): string | undefined {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function errorMessage(res: SembleHttpResponse): string {
  const data = res.data as Record<string, unknown> | null;
  const message = data?.message ?? data?.error;
  return typeof message === "string" && message
    ? message
    : `Semble API request failed (HTTP ${res.status}).`;
}
