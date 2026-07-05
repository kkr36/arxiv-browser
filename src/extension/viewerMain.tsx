import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get("url") ?? "";

function syncViewerUrl(url: string) {
  const next = new URL(window.location.href);
  next.searchParams.set("url", url);
  window.history.replaceState(null, "", next);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      title="paper browser"
      initialInput={initialUrl}
      autoLoadInitial={!!initialUrl}
      onOpenedUrl={syncViewerUrl}
    />
  </StrictMode>,
);
