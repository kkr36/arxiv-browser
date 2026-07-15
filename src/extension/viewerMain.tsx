import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get("url") ?? "";
const PENDING_ROOT_KEY = "pendingRootRequest";
const API_KEY_STORAGE_KEYS = ["openAlexApiKey", "semanticScholarApiKey"] as const;

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
  // null while the initial storage read is in flight, so the warning never
  // flashes for users who do have a key saved.
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);

  useEffect(() => {
    void chrome.storage.local.get(PENDING_ROOT_KEY).then((items) => {
      setPendingRootRequest(asPendingRootRequest(items[PENDING_ROOT_KEY]));
    });
    void chrome.storage.local.get([...API_KEY_STORAGE_KEYS]).then((items) => {
      setHasApiKey(API_KEY_STORAGE_KEYS.some((key) => isNonEmptyString(items[key])));
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: "local" | "sync" | "managed" | "session",
    ) => {
      if (areaName !== "local") return;
      if (changes[PENDING_ROOT_KEY]) {
        setPendingRootRequest(asPendingRootRequest(changes[PENDING_ROOT_KEY].newValue));
      }
      if (API_KEY_STORAGE_KEYS.some((key) => changes[key])) {
        void chrome.storage.local.get([...API_KEY_STORAGE_KEYS]).then((items) => {
          setHasApiKey(API_KEY_STORAGE_KEYS.some((key) => isNonEmptyString(items[key])));
        });
      }
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

  function handlePendingRootNewSession(id: number, input: string) {
    handlePendingRootHandled(id);
    const viewerUrl = chrome.runtime.getURL(
      `extension-viewer.html?url=${encodeURIComponent(input)}`,
    );
    void chrome.tabs.create({ url: viewerUrl });
  }

  return (
    <App
      title="paper browser"
      initialInput={initialUrl}
      autoLoadInitial={!!initialUrl}
      onOpenedUrl={syncViewerUrl}
      pendingRootRequest={pendingRootRequest}
      onPendingRootHandled={handlePendingRootHandled}
      onPendingRootNewSession={handlePendingRootNewSession}
      showApiKeyWarning={hasApiKey === false}
      onOpenApiKeySettings={() => void chrome.runtime.openOptionsPage()}
    />
  );
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
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
