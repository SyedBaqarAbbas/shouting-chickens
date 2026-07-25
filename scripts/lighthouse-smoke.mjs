import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const port = Number(process.env.LIGHTHOUSE_PORT || 4174);
const basePath = process.env.PAGES_BASE_PATH?.trim() || "/shouting-chickens/";
const targetUrl = `http://127.0.0.1:${port}${basePath}`;
const reportDirectory = resolve(process.cwd(), ".lighthouse");
const thresholds = {
  accessibility: 0.9,
  "best-practices": 0.9,
  performance: 0.55,
  seo: 0.9,
};

const server = spawn(process.execPath, ["scripts/serve-dist.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PAGES_BASE_PATH: basePath,
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

let chrome;
try {
  await waitForUrl(targetUrl, 15_000);
  chrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });
  const result = await lighthouse(targetUrl, {
    logLevel: "error",
    onlyCategories: Object.keys(thresholds),
    output: "json",
    port: chrome.port,
  });
  if (!result?.lhr || typeof result.report !== "string") {
    throw new Error("Lighthouse did not return a report");
  }

  await mkdir(reportDirectory, { recursive: true });
  await writeFile(resolve(reportDirectory, "lhr.json"), result.report, "utf8");

  const scores = {};
  for (const [category, minimum] of Object.entries(thresholds)) {
    const score = result.lhr.categories[category]?.score;
    if (typeof score !== "number") {
      throw new Error(`Lighthouse category did not produce a score: ${category}`);
    }
    scores[category] = score;
    if (score < minimum) {
      throw new Error(
        `Lighthouse ${category} score ${score.toFixed(2)} is below ${minimum.toFixed(2)}`,
      );
    }
  }
  await writeFile(
    resolve(reportDirectory, "summary.json"),
    `${JSON.stringify({ targetUrl, scores, thresholds }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Lighthouse smoke passed: ${JSON.stringify(scores)}`);
} finally {
  if (chrome) {
    await chrome.kill();
  }
  server.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) {
      resolveExit();
      return;
    }
    server.once("exit", resolveExit);
    setTimeout(() => {
      server.kill("SIGKILL");
      resolveExit();
    }, 5_000).unref();
  });
  if (server.exitCode && server.exitCode !== 0 && server.exitCode !== null) {
    console.error(serverOutput);
  }
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Production preview did not start: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
  );
}
