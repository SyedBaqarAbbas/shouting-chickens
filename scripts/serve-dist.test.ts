import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: (() => Promise<void>)[] = [];
const serveDistModule = "./serve-dist.mjs";

describe("Pages production preview", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((operation) => operation()));
  });

  it("serves the project root and a direct-reload fallback under the Pages subpath", async () => {
    const { createDistServer } = (await import(serveDistModule)) as {
      createDistServer(options: { root: string; basePath: string }): Server;
    };
    const root = await mkdtemp(resolve(tmpdir(), "shouting-chickens-pages-"));
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, "index.html"), "<h1>Game</h1>", "utf8");
    await writeFile(
      resolve(root, "404.html"),
      '<script>location.replace("/shouting-chickens/")</script>',
      "utf8",
    );
    cleanup.push(() => rm(root, { force: true, recursive: true }));

    const server = createDistServer({ root, basePath: "/shouting-chickens/" });
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolveClosed) => {
          server.close(() => resolveClosed());
        }),
    );
    const port = (server.address() as AddressInfo).port;

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(rootResponse.status).toBe(302);
    expect(rootResponse.headers.get("location")).toBe("/shouting-chickens/");

    const pageResponse = await fetch(`http://127.0.0.1:${port}/shouting-chickens/`);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain("Game");

    const fallbackResponse = await fetch(
      `http://127.0.0.1:${port}/shouting-chickens/play/deep-link`,
      { headers: { accept: "text/html" }, redirect: "manual" },
    );
    expect(fallbackResponse.status).toBe(404);
    expect(await fallbackResponse.text()).toContain('location.replace("/shouting-chickens/")');
  });
});
