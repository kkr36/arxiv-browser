const SESSION_DOWNLOAD_DIR = "paper-browser-sessions";

/** Triggers a browser download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof chrome !== "undefined" && "downloads" in chrome) {
    void downloadBlobWithChrome(blob, filename);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadBlobWithChrome(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: `${SESSION_DOWNLOAD_DIR}/${sanitizeFilename(filename)}`,
          saveAs: false,
        },
        () => {
          const message = chrome.runtime.lastError?.message;
          if (message) reject(new Error(message));
          else resolve();
        },
      );
    });
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/]+/g, "-").replace(/^\.+/, "").trim() || "download";
}
