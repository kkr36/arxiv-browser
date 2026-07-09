import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./options.css";

const API_KEYS = [
  {
    storageKey: "openAlexApiKey",
    label: "OpenAlex API key",
    note: "Used for OpenAlex metadata, author pages, title search, and PDF discovery.",
  },
  {
    storageKey: "semanticScholarApiKey",
    label: "Semantic Scholar API key",
    note: "Used only by the Semantic Scholar fallback resolver.",
  },
] as const;

type ApiKeyStorageKey = (typeof API_KEYS)[number]["storageKey"];
type KeyState = Record<ApiKeyStorageKey, string>;
type ShowState = Record<ApiKeyStorageKey, boolean>;
type StatusState = Record<ApiKeyStorageKey, string>;

const EMPTY_KEYS: KeyState = {
  openAlexApiKey: "",
  semanticScholarApiKey: "",
};

function OptionsApp() {
  const [keys, setKeys] = useState<KeyState>(EMPTY_KEYS);
  const [savedKeys, setSavedKeys] = useState<KeyState>(EMPTY_KEYS);
  const [showKeys, setShowKeys] = useState<ShowState>({
    openAlexApiKey: false,
    semanticScholarApiKey: false,
  });
  const [status, setStatus] = useState<StatusState>({
    openAlexApiKey: "Loading settings...",
    semanticScholarApiKey: "Loading settings...",
  });

  useEffect(() => {
    chrome.storage.local
      .get(API_KEYS.map((entry) => entry.storageKey))
      .then((items) => {
        const nextKeys = keyStateFromStorage(items);
        setKeys(nextKeys);
        setSavedKeys(nextKeys);
        setStatus({
          openAlexApiKey: nextKeys.openAlexApiKey ? "OpenAlex key saved." : "No OpenAlex key saved.",
          semanticScholarApiKey: nextKeys.semanticScholarApiKey
            ? "Semantic Scholar key saved."
            : "No Semantic Scholar key saved.",
        });
      })
      .catch((err) => {
        const message = (err as Error).message;
        setStatus({ openAlexApiKey: message, semanticScholarApiKey: message });
      });
  }, []);

  function updateKey(storageKey: ApiKeyStorageKey, value: string) {
    setKeys((current) => ({ ...current, [storageKey]: value }));
  }

  function saveKey(storageKey: ApiKeyStorageKey) {
    const trimmed = keys[storageKey].trim();
    const action = trimmed
      ? chrome.storage.local.set({ [storageKey]: trimmed })
      : chrome.storage.local.remove(storageKey);
    action
      .then(() => {
        setKeys((current) => ({ ...current, [storageKey]: trimmed }));
        setSavedKeys((current) => ({ ...current, [storageKey]: trimmed }));
        setStatus((current) => ({
          ...current,
          [storageKey]: trimmed ? `${labelPrefix(storageKey)} key saved.` : `${labelPrefix(storageKey)} key cleared.`,
        }));
      })
      .catch((err) =>
        setStatus((current) => ({ ...current, [storageKey]: (err as Error).message })),
      );
  }

  function clearKey(storageKey: ApiKeyStorageKey) {
    chrome.storage.local
      .remove(storageKey)
      .then(() => {
        setKeys((current) => ({ ...current, [storageKey]: "" }));
        setSavedKeys((current) => ({ ...current, [storageKey]: "" }));
        setStatus((current) => ({ ...current, [storageKey]: `${labelPrefix(storageKey)} key cleared.` }));
      })
      .catch((err) =>
        setStatus((current) => ({ ...current, [storageKey]: (err as Error).message })),
      );
  }

  return (
    <main className="options-page">
      <section className="options-panel">
        <h1>Paper Browser Settings</h1>
        {API_KEYS.map((entry) => {
          const dirty = keys[entry.storageKey].trim() !== savedKeys[entry.storageKey];
          const id = `${entry.storageKey}-input`;
          return (
            <section className="key-setting" key={entry.storageKey}>
              <label htmlFor={id}>{entry.label}</label>
              <div className="key-row">
                <input
                  id={id}
                  type={showKeys[entry.storageKey] ? "text" : "password"}
                  value={keys[entry.storageKey]}
                  onChange={(e) => updateKey(entry.storageKey, e.currentTarget.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowKeys((current) => ({
                      ...current,
                      [entry.storageKey]: !current[entry.storageKey],
                    }))
                  }
                >
                  {showKeys[entry.storageKey] ? "Hide" : "Show"}
                </button>
              </div>
              <div className="actions">
                <button type="button" onClick={() => saveKey(entry.storageKey)} disabled={!dirty}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => clearKey(entry.storageKey)}
                  disabled={!savedKeys[entry.storageKey] && !keys[entry.storageKey]}
                >
                  Clear
                </button>
              </div>
              <p className="status">{status[entry.storageKey]}</p>
              <p className="note">{entry.note}</p>
            </section>
          );
        })}
        <p className="storage-note">
          Keys are stored locally in Chrome and used only by the extension background worker.
        </p>
      </section>
    </main>
  );
}

function keyStateFromStorage(items: Record<string, unknown>): KeyState {
  return {
    openAlexApiKey: typeof items.openAlexApiKey === "string" ? items.openAlexApiKey : "",
    semanticScholarApiKey:
      typeof items.semanticScholarApiKey === "string" ? items.semanticScholarApiKey : "",
  };
}

function labelPrefix(storageKey: ApiKeyStorageKey): string {
  return storageKey === "openAlexApiKey" ? "OpenAlex" : "Semantic Scholar";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
