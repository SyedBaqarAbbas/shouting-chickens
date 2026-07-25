import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { distDirectory } from "./release-files.mjs";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export function normalizedBasePath(value = process.env.PAGES_BASE_PATH) {
  const candidate = value?.trim() || "/shouting-chickens/";
  const withLeadingSlash = candidate.startsWith("/") ? candidate : `/${candidate}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function createDistServer({ root = distDirectory(), basePath = normalizedBasePath() } = {}) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(302, { location: basePath });
        response.end();
        return;
      }
      if (!requestUrl.pathname.startsWith(basePath)) {
        respond(response, 404, "Not found");
        return;
      }

      const relativePath = decodeURIComponent(requestUrl.pathname.slice(basePath.length));
      const requestedPath =
        relativePath === "" || relativePath.endsWith("/")
          ? `${relativePath}index.html`
          : relativePath;
      const absolutePath = resolve(root, requestedPath);
      if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
        respond(response, 400, "Invalid path");
        return;
      }

      const metadata = await stat(absolutePath).catch(() => null);
      if (!metadata?.isFile()) {
        respond(response, 404, "Not found");
        return;
      }

      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": metadata.size,
        "content-type": CONTENT_TYPES.get(extname(absolutePath)) || "application/octet-stream",
        "cross-origin-opener-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(absolutePath).pipe(response);
    } catch (error) {
      respond(response, 500, error instanceof Error ? error.message : "Server error");
    }
  });
}

function respond(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

async function run() {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.PORT || 4173);
  const basePath = normalizedBasePath();
  const server = createDistServer({ basePath });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListening);
  });
  console.log(`Serving sealed dist at http://${host}:${port}${basePath}`);

  const close = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await run();
}
