import type { JsonResponse } from "../core/net/fetchJson";
import type { PublicPdfSearchRequest, PublicPdfSearchResult } from "../core/webPdfSearch";

export type ExtensionRequest =
  | { type: "fetch-pdf"; url: string }
  | { type: "fetch-json"; url: string }
  | { type: "fetch-text"; url: string }
  | { type: "find-public-pdf"; request: PublicPdfSearchRequest };

export type ExtensionResponse =
  | { ok: true; type: "pdf"; bytesBase64: string }
  | { ok: true; type: "json"; response: JsonResponse<unknown> }
  | { ok: true; type: "text"; text: string | null }
  | { ok: true; type: "public-pdf"; result: PublicPdfSearchResult | null }
  | { ok: false; error: string };

export function hasExtensionRuntime(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

export function sendExtensionRequest<T extends ExtensionResponse>(
  request: ExtensionRequest,
): Promise<T> {
  if (!hasExtensionRuntime()) {
    return Promise.reject(new Error("Chrome extension runtime is unavailable."));
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage<ExtensionRequest, T>(request, (response) => {
      const message = chrome.runtime.lastError?.message;
      if (message) {
        reject(new Error(message));
        return;
      }
      if (!response) {
        reject(new Error("Extension background did not respond."));
        return;
      }
      resolve(response);
    });
  });
}
