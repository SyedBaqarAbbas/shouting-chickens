import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const ARTIFACT_MANIFEST_FILE = "artifact-manifest.json";
export const RELEASE_MANIFEST_FILE = "release.json";

export function distDirectory() {
  return resolve(process.cwd(), process.env.RELEASE_DIST_DIR?.trim() || "dist");
}

export async function listArtifactFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Release artifacts may not contain symbolic links: ${releasePath(root, absolutePath)}`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
      } else if (metadata.isFile()) {
        files.push(releasePath(root, absolutePath));
      } else {
        throw new Error(`Unsupported release artifact entry: ${releasePath(root, absolutePath)}`);
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function fileEvidence(root, file) {
  const bytes = await readFile(resolve(root, file));
  return {
    path: file,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readJson(root, file) {
  return JSON.parse(await readFile(resolve(root, file), "utf8"));
}

export function validateReleaseIdentity(
  release,
  { requireProduction = Boolean(process.env.CI) } = {},
) {
  if (
    !release ||
    release.schemaVersion !== 1 ||
    typeof release.version !== "string" ||
    typeof release.commitSha !== "string"
  ) {
    throw new Error("release.json must contain schemaVersion 1, version, and commitSha");
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version)) {
    throw new Error(`Invalid release version: ${release.version}`);
  }

  const validCommit =
    release.commitSha === "development" || /^[0-9a-f]{7,64}$/i.test(release.commitSha);
  if (!validCommit || (requireProduction && release.commitSha === "development")) {
    throw new Error(`Invalid release commit SHA: ${release.commitSha}`);
  }

  const expectedVersion = process.env.APP_VERSION?.trim();
  const expectedCommit = process.env.COMMIT_SHA?.trim();
  if (requireProduction && (!expectedVersion || !expectedCommit)) {
    throw new Error("CI release builds require explicit APP_VERSION and COMMIT_SHA provenance");
  }
  if (requireProduction && expectedCommit && !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error("CI COMMIT_SHA must be the exact 40-character lowercase Git commit SHA");
  }
  if (expectedVersion && release.version !== expectedVersion) {
    throw new Error(
      `release.json version ${release.version} does not match APP_VERSION ${expectedVersion}`,
    );
  }
  if (expectedCommit && release.commitSha !== expectedCommit) {
    throw new Error(
      `release.json commit ${release.commitSha} does not match COMMIT_SHA ${expectedCommit}`,
    );
  }
}

function releasePath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}
