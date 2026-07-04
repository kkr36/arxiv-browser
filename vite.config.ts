import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Dev-only PDF proxy. Many hosts (arXiv included, inconsistently) don't send
 * CORS headers on PDF bytes, so the browser can't `fetch()` them directly.
 * This mirrors what a browser-extension background script would do (fetch
 * with host permissions, no CORS involved) so the core loading code can stay
 * identical between the web app and a future extension.
 *
 * Note: both proxies are open relays (`?url=` fetches anything). That is
 * fine for a local dev server but must never be deployed as-is.
 */
function pdfProxyPlugin(): Plugin {
  return {
    name: "pdf-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy-pdf", async (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://localhost");
        const target = fullUrl.searchParams.get("url");
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url param");
          return;
        }
        try {
          const upstream = await fetch(target, {
            headers: { "User-Agent": "arxiv-browser/0.1 (+local dev proxy)" },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (!upstream.ok || !upstream.body) {
            const detail = (await upstream.text().catch(() => "")).slice(0, 200);
            res.statusCode = upstream.status || 502;
            res.end(
              `Upstream ${target} responded ${upstream.status} ${upstream.statusText}${detail ? `: ${detail}` : ""}`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            upstream.headers.get("content-type") ?? "application/pdf",
          );
          res.setHeader("Access-Control-Allow-Origin", "*");
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.end(buffer);
        } catch (err) {
          res.statusCode = 502;
          res.end(`Proxy could not reach ${target}: ${(err as Error).message}`);
        }
      });
    },
  };
}

/**
 * Dev-only JSON proxy for the Semantic Scholar API, which does not send
 * CORS headers for browser-origin requests (notably: none at all on 429
 * responses). Same rationale as the PDF proxy above: a browser extension's
 * background script would fetch this directly instead.
 *
 * If `S2_API_KEY` is set (e.g. in `.env.local`), it is attached as
 * `x-api-key` for Semantic Scholar requests — keeping the key out of
 * client-side code. `Retry-After` is forwarded so the client can pace
 * retries after a 429.
 */
function jsonProxyPlugin(s2ApiKey?: string): Plugin {
  return {
    name: "json-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy-json", async (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://localhost");
        const target = fullUrl.searchParams.get("url");
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url param");
          return;
        }
        try {
          const headers: Record<string, string> = {
            "User-Agent": "arxiv-browser/0.1 (+local dev proxy)",
          };
          if (s2ApiKey && new URL(target).hostname.endsWith("semanticscholar.org")) {
            headers["x-api-key"] = s2ApiKey;
          }
          const upstream = await fetch(target, {
            headers,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          const body = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
          res.setHeader("Access-Control-Allow-Origin", "*");
          const retryAfter = upstream.headers.get("retry-after");
          if (retryAfter) res.setHeader("Retry-After", retryAfter);
          res.end(body);
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: `Proxy could not reach ${target}: ${(err as Error).message}` }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), pdfProxyPlugin(), jsonProxyPlugin(env.S2_API_KEY)],
  };
});
