import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ARTIFACT_MANIFEST_FILE,
  RELEASE_MANIFEST_FILE,
  distDirectory,
  fileEvidence,
  listArtifactFiles,
  readJson,
  validateReleaseIdentity,
} from "./release-files.mjs";

const root = distDirectory();
const release = await readJson(root, RELEASE_MANIFEST_FILE);
validateReleaseIdentity(release);

const files = (await listArtifactFiles(root)).filter((file) => file !== ARTIFACT_MANIFEST_FILE);
const evidence = await Promise.all(files.map((file) => fileEvidence(root, file)));
const manifest = {
  schemaVersion: 1,
  version: release.version,
  commitSha: release.commitSha,
  files: evidence,
};
const temporaryPath = resolve(root, `${ARTIFACT_MANIFEST_FILE}.tmp`);
await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
await rename(temporaryPath, resolve(root, ARTIFACT_MANIFEST_FILE));

console.log(
  `Sealed ${evidence.length} release files for ${release.version} (${release.commitSha}).`,
);
