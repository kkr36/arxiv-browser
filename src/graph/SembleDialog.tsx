import { useRef, useState } from "react";
import { hasExtensionRuntime } from "../extension/runtimeBridge";
import type { SessionExport } from "../core/export/sessionExport";
import { createSembleClient, SEMBLE_APP_URL } from "../core/export/semble/sembleClient";
import { resolveSembleTransport } from "../core/export/semble/sembleTransport";
import {
  publishSessionToSemble,
  type PublishProgress,
  type PublishResult,
} from "../core/export/semble/publishToSemble";

const API_KEY_STORAGE = "arxiv-browser:semble-api-key";

interface SembleDialogProps {
  session: SessionExport;
  onClose: () => void;
}

type Phase = "idle" | "publishing" | "done" | "error";

export function SembleDialog({ session, onClose }: SembleDialogProps) {
  const paperCount = session.nodes.filter((n) => n.kind !== "author").length;
  const [apiKey, setApiKey] = useState(() => storedApiKey());
  const [rememberKey, setRememberKey] = useState(() => !!storedApiKey());
  const [name, setName] = useState(session.title);
  const [description, setDescription] = useState(
    `${paperCount} paper${paperCount === 1 ? "" : "s"} explored with arxiv-browser on ${session.exportedAt}.`,
  );
  const [accessType, setAccessType] = useState<"OPEN" | "CLOSED">("CLOSED");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<PublishProgress | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // In the web app a blank key falls back to the dev proxy (SEMBLE_API_KEY
  // from .env.local); the extension has no proxy, so there a key is required.
  const keyRequired = hasExtensionRuntime();

  async function handlePublish() {
    const key = apiKey.trim();
    if (keyRequired && !key) return;
    try {
      if (rememberKey && key) localStorage.setItem(API_KEY_STORAGE, key);
      else if (!rememberKey) localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      // persistence is a nice-to-have
    }

    setPhase("publishing");
    setError(null);
    setResult(null);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const client = createSembleClient(key, resolveSembleTransport());
      const published = await publishSessionToSemble(session, client, {
        collectionName: name.trim() || session.title,
        description,
        accessType,
        onProgress: setProgress,
        signal: abort.signal,
      });
      setResult(published);
      setPhase("done");
    } catch (err) {
      if (abort.signal.aborted) {
        setPhase("idle");
        setProgress(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  const publishing = phase === "publishing";

  return (
    <div className="semble-backdrop" onClick={handleClose}>
      <div className="semble-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="semble-dialog-title">Publish to Semble</div>
        <div className="semble-dialog-subtitle">
          Shares this session as a collection of cards on{" "}
          <a href={SEMBLE_APP_URL} target="_blank" rel="noreferrer">
            semble.so
          </a>
          . Citation links become “Opened via” notes — Semble has no graph edges.
        </div>

        {(phase === "idle" || phase === "error") && (
          <>
            <label className="semble-field">
              <span>
                API key ·{" "}
                <a href={`${SEMBLE_APP_URL}/settings/api-keys`} target="_blank" rel="noreferrer">
                  create one
                </a>
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  keyRequired ? "semble API key" : "blank = SEMBLE_API_KEY from .env.local"
                }
                autoFocus
              />
            </label>
            <label className="semble-remember">
              <input
                type="checkbox"
                checked={rememberKey}
                onChange={(e) => setRememberKey(e.target.checked)}
              />
              Remember key in this browser
            </label>
            <label className="semble-field">
              <span>Collection name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="semble-field">
              <span>Description</span>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="semble-field">
              <span>Visibility</span>
              <select
                value={accessType}
                onChange={(e) => setAccessType(e.target.value as "OPEN" | "CLOSED")}
              >
                <option value="CLOSED">Closed (only you can add cards)</option>
                <option value="OPEN">Open (others can contribute)</option>
              </select>
            </label>
            {error && <div className="semble-error">{error}</div>}
          </>
        )}

        {publishing && (
          <div className="semble-progress">
            {progress?.phase === "card"
              ? `Adding card ${progress.index} / ${progress.total} — ${progress.nodeTitle}`
              : "Creating collection…"}
          </div>
        )}

        {phase === "done" && result && (
          <div className="semble-result">
            <ul className="semble-card-list">
              {result.cards.map((card) => (
                <li key={card.nodeId} className={`semble-card-${card.status}`}>
                  {card.status === "created" && "✓"}
                  {card.status === "skipped-no-url" && "–"}
                  {card.status === "failed" && "✕"} {card.title}
                  {card.status === "skipped-no-url" && " (no public URL)"}
                  {card.status === "failed" && card.error ? ` — ${card.error}` : ""}
                </li>
              ))}
            </ul>
            {result.collectionUrl ? (
              <a className="semble-link" href={result.collectionUrl} target="_blank" rel="noreferrer">
                Open the collection on semble.so →
              </a>
            ) : (
              <div className="semble-dialog-subtitle">
                Collection created — find it in your library on{" "}
                <a href={SEMBLE_APP_URL} target="_blank" rel="noreferrer">
                  semble.so
                </a>
                .
              </div>
            )}
          </div>
        )}

        <div className="semble-actions">
          {(phase === "idle" || phase === "error") && (
            <>
              <button onClick={handleClose}>Cancel</button>
              <button
                className="semble-primary"
                onClick={handlePublish}
                disabled={(keyRequired && !apiKey.trim()) || !name.trim()}
              >
                Publish
              </button>
            </>
          )}
          {publishing && <button onClick={handleCancel}>Cancel</button>}
          {phase === "done" && (
            <button className="semble-primary" onClick={handleClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function storedApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}
