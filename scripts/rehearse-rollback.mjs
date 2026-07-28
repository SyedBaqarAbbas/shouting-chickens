import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ARTIFACT_MANIFEST_FILE,
  RELEASE_MANIFEST_FILE,
  fileEvidence,
  listArtifactFiles,
  readJson,
  validateReleaseIdentity,
} from "./release-files.mjs";

const currentDirectory = requiredDirectory("CURRENT_DIST_DIR");
const rollbackDirectory = requiredDirectory("ROLLBACK_DIST_DIR");
const current = await verifySealedDirectory(currentDirectory);
const rollback = await verifySealedDirectory(rollbackDirectory);

if (current.commitSha === rollback.commitSha) {
  throw new Error("Rollback rehearsal requires different current and known-good commit SHAs");
}
if (current.cacheName === rollback.cacheName) {
  throw new Error("Rollback rehearsal requires distinct versioned PWA cache identities");
}

const expectedRollbackCommit = process.env.ROLLBACK_EXPECTED_COMMIT?.trim();
if (expectedRollbackCommit && rollback.commitSha !== expectedRollbackCommit) {
  throw new Error(
    `Known-good artifact commit ${rollback.commitSha} does not match ROLLBACK_EXPECTED_COMMIT ${expectedRollbackCommit}`,
  );
}

console.log(
  `Rollback artifact rehearsal passed: ${current.version} (${current.commitSha}) -> ` +
    `${rollback.version} (${rollback.commitSha}).`,
);
console.log(`Known-good artifact manifest SHA-256: ${rollback.artifactManifestSha}`);
console.log(
  "Revert the faulty source on main and run the complete release gate; this rehearsal never deploys an old artifact directly.",
);

async function verifySealedDirectory(directory) {
  const metadata = await stat(directory).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error(`Rollback rehearsal directory does not exist: ${directory}`);
  }
  const release = await readJson(directory, RELEASE_MANIFEST_FILE);
  const artifact = await readJson(directory, ARTIFACT_MANIFEST_FILE);
  const pwaRelease = await readJson(directory, "pwa-release.json");
  validateReleaseIdentity(release, { requireProduction: false });
  if (
    artifact.schemaVersion !== 1 ||
    artifact.version !== release.version ||
    artifact.commitSha !== release.commitSha ||
    !Array.isArray(artifact.files)
  ) {
    throw new Error(`Artifact identity mismatch in rollback rehearsal directory: ${directory}`);
  }

  const actualFiles = (await listArtifactFiles(directory)).filter(
    (file) => file !== ARTIFACT_MANIFEST_FILE,
  );
  if (JSON.stringify(artifact.files.map((entry) => entry.path)) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `Artifact manifest does not enumerate the exact rollback payload: ${directory}`,
    );
  }
  for (const entry of artifact.files) {
    const actual = await fileEvidence(directory, entry.path);
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) {
      throw new Error(`Rollback artifact integrity mismatch: ${entry.path}`);
    }
  }

  const expectedCacheName = `shouting-chickens-shell-${safeIdentity(
    release.version,
  )}-${safeIdentity(release.commitSha)}`;
  if (
    pwaRelease.schemaVersion !== 1 ||
    pwaRelease.version !== release.version ||
    pwaRelease.commitSha !== release.commitSha ||
    pwaRelease.cacheName !== expectedCacheName ||
    !Array.isArray(pwaRelease.assets) ||
    pwaRelease.assets.length === 0 ||
    pwaRelease.assets[0] !== "./" ||
    new Set(pwaRelease.assets).size !== pwaRelease.assets.length
  ) {
    throw new Error(`PWA identity mismatch in rollback rehearsal directory: ${directory}`);
  }
  const payloadPaths = new Set(actualFiles);
  for (const asset of pwaRelease.assets) {
    if (
      typeof asset !== "string" ||
      (asset !== "./" &&
        (!asset.startsWith("./") ||
          asset.includes("\\") ||
          asset.includes("?") ||
          asset.includes("#") ||
          asset.includes("..") ||
          !payloadPaths.has(asset.slice(2)))) ||
      /^(?:blob|data|https?):/i.test(asset) ||
      /(?:^|\/)(?:api|graphql|reports?|replays?|recordings?|captures?|media|uploads?)(?:\/|$)/i.test(
        asset,
      )
    ) {
      throw new Error(`Unsafe PWA source-shell entry in rollback artifact: ${asset}`);
    }
  }
  const worker = await readFile(resolve(directory, "service-worker.js"), "utf8");
  if (
    !worker.includes(JSON.stringify(`${release.version}:${release.commitSha}`)) ||
    !worker.includes(JSON.stringify(pwaRelease.cacheName)) ||
    !worker.includes(JSON.stringify(pwaRelease.assets, null, 2)) ||
    !worker.includes('event.data.type === "APPLY_UPDATE"')
  ) {
    throw new Error(`Service-worker identity mismatch in rollback artifact: ${directory}`);
  }

  const manifestBytes = await readFile(resolve(directory, ARTIFACT_MANIFEST_FILE));
  return {
    version: release.version,
    commitSha: release.commitSha,
    cacheName: pwaRelease.cacheName,
    artifactManifestSha: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

function requiredDirectory(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the local rollback rehearsal`);
  }
  return resolve(process.cwd(), value);
}

function safeIdentity(value) {
  return value.replace(/[^0-9A-Za-z.-]/g, "-");
}
