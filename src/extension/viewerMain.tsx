import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get("url") ?? "";
const PENDING_ROOT_KEY = "pendingRootRequest";

interface PendingRootRequest {
  id: number;
  input: string;
}

function syncViewerUrl(url: string) {
  const next = new URL(window.location.href);
  next.searchParams.set("url", url);
  window.history.replaceState(null, "", next);
}

function ExtensionViewerApp() {
  const [pendingRootRequest, setPendingRootRequest] = useState<PendingRootRequest | null>(null);

  useEffect(() => {
    void chrome.storage.local.get(PENDING_ROOT_KEY).then((items) => {
      setPendingRootRequest(asPendingRootRequest(items[PENDING_ROOT_KEY]));
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: "local" | "sync" | "managed" | "session",
    ) => {
      if (areaName !== "local" || !changes[PENDING_ROOT_KEY]) return;
      setPendingRootRequest(asPendingRootRequest(changes[PENDING_ROOT_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
  }, []);

  function handlePendingRootHandled(id: number) {
    setPendingRootRequest((current) => (current?.id === id ? null : current));
    void chrome.storage.local.get(PENDING_ROOT_KEY).then((items) => {
      const current = asPendingRootRequest(items[PENDING_ROOT_KEY]);
      if (current?.id === id) void chrome.storage.local.remove(PENDING_ROOT_KEY);
    });
  }

  return (
    <App
      title="paper browser"
      initialInput={initialUrl}
      autoLoadInitial={!!initialUrl}
      onOpenedUrl={syncViewerUrl}
      pendingRootRequest={pendingRootRequest}
      onPendingRootHandled={handlePendingRootHandled}
    />
  );
}

function asPendingRootRequest(value: unknown): PendingRootRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { id?: unknown; input?: unknown };
  return typeof candidate.id === "number" && typeof candidate.input === "string"
    ? { id: candidate.id, input: candidate.input }
    : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ExtensionViewerApp />
  </StrictMode>,
);
