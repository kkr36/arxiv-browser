import type { SessionExport, SessionExportNode } from "../sessionExport";
import { SembleApiError, type SembleClient } from "./sembleClient";

export interface PublishProgress {
  phase: "collection" | "card" | "done";
  index?: number;
  total?: number;
  nodeTitle?: string;
}

export interface CardOutcome {
  nodeId: string;
  title: string;
  status: "created" | "skipped-no-url" | "failed";
  cardId?: string;
  error?: string;
}

export interface PublishResult {
  collectionId: string;
  collectionUrl?: string;
  cards: CardOutcome[];
}

export interface PublishOptions {
  collectionName: string;
  description?: string;
  accessType?: "OPEN" | "CLOSED";
  onProgress?: (progress: PublishProgress) => void;
  signal?: AbortSignal;
  /** Delay between card creations, to stay polite with the alpha API. */
  pacingMs?: number;
}

/**
 * Publishes a session to Semble as one collection of URL cards, in trail
 * order. Semble has no card-to-card edges, so graph structure degrades to
 * provenance hints: each non-root card's note says which paper it was opened
 * from, and `viaCardId` points at the parent's card. Per-card failures are
 * recorded and skipped — an alpha API hiccup must not abort the whole run.
 */
export async function publishSessionToSemble(
  session: SessionExport,
  client: SembleClient,
  opts: PublishOptions,
): Promise<PublishResult> {
  const { onProgress, signal, pacingMs = 300 } = opts;
  const publishable = session.nodes.filter((n) => n.canonicalUrl);
  const unlinkable = session.nodes.filter((n) => !n.canonicalUrl);

  onProgress?.({ phase: "collection" });
  let description = opts.description?.trim() || "";
  if (unlinkable.length) {
    const names = unlinkable.map((n) => n.title).join("; ");
    description = `${description}${description ? "\n\n" : ""}Not linkable: ${names}`;
  }
  const { collectionId } = await client.createCollection({
    name: opts.collectionName,
    description: description || undefined,
    accessType: opts.accessType ?? "CLOSED",
  });

  const cards: CardOutcome[] = [];
  const cardIds = new Map<string, string>();
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  // viaCardId semantics are alpha; after one 400-class rejection stop sending it.
  let viaCardSupported = true;

  let index = 0;
  for (const node of session.nodes) {
    throwIfAborted(signal);
    if (!node.canonicalUrl) {
      cards.push({ nodeId: node.id, title: node.title, status: "skipped-no-url" });
      continue;
    }
    index += 1;
    onProgress?.({ phase: "card", index, total: publishable.length, nodeTitle: node.title });

    const viaCardId = viaCardSupported
      ? node.parents.map((id) => cardIds.get(id)).find(Boolean)
      : undefined;
    try {
      const cardId = await addCardWithRetry(client, {
        url: node.canonicalUrl,
        note: cardNote(node, byId),
        collectionIds: [collectionId],
        viaCardId,
        onViaCardRejected: () => {
          viaCardSupported = false;
        },
        signal,
      });
      cardIds.set(node.id, cardId);
      cards.push({ nodeId: node.id, title: node.title, status: "created", cardId });
    } catch (err) {
      if (signal?.aborted) throw err;
      cards.push({ nodeId: node.id, title: node.title, status: "failed", error: messageOf(err) });
    }
    if (index < publishable.length) await sleep(pacingMs, signal);
  }

  const collectionUrl = await client.getCollectionPageUrl(collectionId);
  onProgress?.({ phase: "done" });
  return { collectionId, collectionUrl, cards };
}

async function addCardWithRetry(
  client: SembleClient,
  input: {
    url: string;
    note?: string;
    collectionIds: string[];
    viaCardId?: string;
    onViaCardRejected: () => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const request = {
    url: input.url,
    note: input.note,
    collectionIds: input.collectionIds,
    ...(input.viaCardId ? { viaCardId: input.viaCardId } : {}),
  };
  try {
    return (await client.addUrlCard(request)).urlCardId;
  } catch (err) {
    if (err instanceof SembleApiError && err.status === 429) {
      await sleep(err.retryAfterMs ?? 2000, input.signal);
      return (await client.addUrlCard(request)).urlCardId;
    }
    if (input.viaCardId && err instanceof SembleApiError && err.status >= 400 && err.status < 500) {
      input.onViaCardRejected();
      const { viaCardId: _dropped, ...withoutVia } = request;
      return (await client.addUrlCard(withoutVia)).urlCardId;
    }
    throw err;
  }
}

function cardNote(node: SessionExportNode, byId: Map<string, SessionExportNode>): string | undefined {
  const lines: string[] = [];
  if (node.kind === "author") {
    const bits = [
      node.paperCount !== undefined ? `${node.paperCount} works` : "",
      node.citationCount !== undefined ? `${node.citationCount} citations` : "",
      node.hIndex !== undefined ? `h-index ${node.hIndex}` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(bits.join(" · "));
  } else {
    const authors = node.authors ?? [];
    const bits = [
      authors.slice(0, 4).join(", ") + (authors.length > 4 ? ", et al." : ""),
      node.year ? String(node.year) : "",
      node.venue ?? "",
    ].filter(Boolean);
    if (bits.length) lines.push(bits.join(" · "));
  }
  const parentTitles = node.parents
    .map((id) => byId.get(id)?.title)
    .filter((t): t is string => !!t);
  if (parentTitles.length) lines.push(`Opened via: ${parentTitles.join("; ")}`);
  return lines.length ? lines.join("\n") : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new DOMException("Publishing cancelled.", "AbortError");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
