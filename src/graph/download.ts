const SESSION_DOWNLOAD_DIR = "paper-browser-sessions";

/** Triggers a browser download of `blob` as `filename`. */
export function downloadBlob(
  blob: Blob,
  filename: string,
  options: { directory?: string } = {},
): void {
  if (typeof chrome !== "undefined" && "downloads" in chrome) {
    void downloadBlobWithChrome(blob, filename, options.directory);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadBlobWithChrome(
  blob: Blob,
  filename: string,
  directory?: string,
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const safeFilename = sanitizeFilename(filename);
  const downloadName = directory
    ? `${sanitizeFilename(directory)}/${safeFilename}`
    : safeFilename;
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: downloadName,
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

export { SESSION_DOWNLOAD_DIR };
