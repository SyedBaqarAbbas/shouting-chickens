import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";

import {
  ARTIFACT_MANIFEST_FILE,
  RELEASE_MANIFEST_FILE,
  distDirectory,
  fileEvidence,
  listArtifactFiles,
  readJson,
  validateReleaseIdentity,
} from "./release-files.mjs";

const ORIGINAL_GAME_ATLAS_FILE = "assets/shouting-chickens-atlas.svg";
const ORIGINAL_GAME_ATLAS_BUDGET_BYTES = 24 * 1_024;
const ALLOWED_FILES = new Set([
  ".nojekyll",
  "artifact-manifest.json",
  ORIGINAL_GAME_ATLAS_FILE,
  "audio/voice-rms-processor.js",
  "favicon.svg",
  "index.html",
  "legal.css",
  "privacy/index.html",
  "release.json",
  "support/index.html",
]);
const ALLOWED_ASSET = /^assets\/[0-9A-Za-z_-]+\.(?:css|js)$/;
const FORBIDDEN_PATH =
  /(?:^|\/)(?:image[123](?:\.|$)|coverage|playwright-report|test-results|screenshots?|references?|recordings?|captures?|replays?)(?:\/|\.|$)/i;
const FORBIDDEN_EXTENSION =
  /\.(?:env|key|pem|p12|pfx|map|trace|zip|tar|gz|wav|mp3|mp4|m4a|mov|ogg|webm)$/i;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\blin_api_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
];
const BINARY_SIGNATURES = [
  { label: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { label: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { label: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { label: "Ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { label: "WebM", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { label: "ID3 media", bytes: [0x49, 0x44, 0x33] },
  { label: "RIFF media", bytes: [0x52, 0x49, 0x46, 0x46] },
];
const FORBIDDEN_REFERENCE_SHA256 = new Set([
  "089aba83228237544e4924dcbbc89cd1315ab97dc3daece9297a84117dd9ed96",
  "d090a576188e23d05e6d5311781b485350dcb5ebe2800c036f1cb4879680d7b3",
  "1af743bd2220e8ab6e9441c95d8482cc54cf3b34c7b6f3efb9c03d311aa003c8",
]);
// Phaser embeds these tiny engine fallback images in its distributed source.
// The allowlist is intentionally exact: MIME type, decoded byte count, and
// decoded SHA-256 must all match. Any other bundled data image is rejected.
const ALLOWED_PHASER_IMAGE_DATA = new Map([
  ["88e6382d15edbda0254ba0ad7f224f41b358a21ebfad6e1eed439f5ddf0ea245", 106],
  ["42deb9219fc21f52ec47f6de9f2cd7bbd2b6eff02e03fb2e77b935f3f2a849db", 253],
  ["35998019fdbb8736d1a6ac45e2117c51cc08edcaf064ada96bf6c675e24c4ff3", 117],
  ["870c166259be9cbffe2252d65c927db6ddb1d1d037e5f66a7f6d67886a00d7a0", 366],
  ["b86ca7249e6f28cc9af909dcc5501e67101273ff2a2a19c408779a0fbf27e733", 82],
  ["f006c556c753a58b408277de14a33ffdc8a921625cd682042960de78c6df2552", 82],
]);
const ALLOWED_PHASER_BASE64_FRAGMENTS = new Set([
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAg",
  "AQMAAABJtOi3AAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAABVJREFUeF7NwIEAAAAAgKD9qdeocAMAoAABm3DkcAAAAABJRU5ErkJggg==",
  "CAIAAAD8GO2jAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAJ9JREFUeNq01ssOwyAMRFG46v//Mt1ESmgh+DFmE2GPOBARKb2NVjo+17PXLD8a1+pl5+A+wSgFygymWYHBb0FtsKhJDdZlncG2IzJ4ayoMDv20wTmSMzClEgbWYNTAkQ0Z+OJ+A/eWnAaR9+oxCF4Os0H8htsMUp+pwcgBBiMNnAwF8GqIgL2hAzaGFFgZauDPKABmowZ4GL369/0rwACp2yA/ttmvsQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABdJREFUeNpi/P//PwMMMDEgAdwcgAADAJZuAwXJYZOzAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAOCAYAAAAmL5yKAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAARBJREFUeNpi/P//P0OHsPB/BiCoePuWkYFEwALSXJElzMBgLwE2CNkQxgWr/yMr/p8QimlBu5DQ//+8vBBco/ofzAe6imH+qv/53/6jYJAYSA4ZoxoANYTPKhiuCQZwGcJU+e4dqpMmvsDq14krV2MPAxDha2CMKvoXoiE/PBQUDgQD8j82UFae9B9bOIC8B9UD9gIjjIMN7Ns6lWHn4XMoYu62RgxO3tkMjIyMII2MYAOAtmFVhA+ADHf2ycGMRhANjUq8YO+WKWCvgAORIV8CkpDCrzIwsLIymC1qAtuAD4Bsh3sBmqAY3qcGwL2AC4DCpKtzHlgzOLWihwEuzTCN0GhDJHeYC4gByBphACDAAH2dDIxdjr+VAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAABAQMAAADD8p2OAAAAA1BMVEX/",
  "AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
]);

const root = distDirectory();
const files = await listArtifactFiles(root);
const release = await readJson(root, RELEASE_MANIFEST_FILE);
const artifact = await readJson(root, ARTIFACT_MANIFEST_FILE);
validateReleaseIdentity(release);

for (const required of ALLOWED_FILES) {
  if (!files.includes(required)) {
    throw new Error(`Required production artifact is missing: ${required}`);
  }
}

if (
  artifact.schemaVersion !== 1 ||
  artifact.version !== release.version ||
  artifact.commitSha !== release.commitSha ||
  !Array.isArray(artifact.files)
) {
  throw new Error("artifact-manifest.json identity does not match release.json");
}

const actualPayloadFiles = files.filter((file) => file !== ARTIFACT_MANIFEST_FILE);
const declaredFiles = artifact.files.map((entry) => entry.path);
if (JSON.stringify(declaredFiles) !== JSON.stringify(actualPayloadFiles)) {
  throw new Error("artifact-manifest.json does not enumerate the exact release payload");
}

for (const entry of artifact.files) {
  if (
    typeof entry.path !== "string" ||
    typeof entry.bytes !== "number" ||
    typeof entry.sha256 !== "string"
  ) {
    throw new Error("artifact-manifest.json contains malformed file evidence");
  }
  const actual = await fileEvidence(root, entry.path);
  if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
    throw new Error(`Artifact integrity mismatch: ${entry.path}`);
  }
}

for (const file of files) {
  if (!ALLOWED_FILES.has(file) && !ALLOWED_ASSET.test(file)) {
    throw new Error(`Unexpected file in production artifact: ${file}`);
  }
  if (FORBIDDEN_PATH.test(file) || FORBIDDEN_EXTENSION.test(file)) {
    throw new Error(`Forbidden release artifact path: ${file}`);
  }

  const bytes = await readFile(resolve(root, file));
  assertTextArtifact(file, bytes);
  const text = bytes.toString("utf8");
  if (file === ORIGINAL_GAME_ATLAS_FILE) {
    if (bytes.byteLength > ORIGINAL_GAME_ATLAS_BUDGET_BYTES) {
      throw new Error(
        `Original game atlas exceeds ${ORIGINAL_GAME_ATLAS_BUDGET_BYTES} bytes: ${bytes.byteLength}`,
      );
    }
    if (
      !text.includes('viewBox="0 0 1280 80"') ||
      /<image\b|data:image|tiktok|watermark/i.test(text)
    ) {
      throw new Error("Original game atlas is malformed or contains an embedded/copied payload");
    }
  }
  if (/data:(?:audio|video)\//i.test(text)) {
    throw new Error(`Embedded media payload found in production artifact: ${file}`);
  }
  assertNoUnapprovedImageData(file, text);
  assertNoEncodedMedia(file, text);
  for (const secretPattern of SECRET_PATTERNS) {
    if (secretPattern.test(text)) {
      throw new Error(`Possible secret found in production artifact: ${file}`);
    }
  }
}

for (const file of files.filter((candidate) => /\.(?:css|html|js)$/.test(candidate))) {
  const text = await readFile(resolve(root, file), "utf8");
  const rootAbsolutePatterns = [
    /\b(?:action|href|poster|src)\s*=\s*["']\s*(\/(?!\/)[^"']*)["']/g,
    /\bsrcset\s*=\s*["'][^"']*(\/(?!\/)[^"',\s]*)/g,
    /\burl\(\s*["']?(\/(?!\/)[^)"']*)/g,
  ];
  for (const pattern of rootAbsolutePatterns) {
    for (const match of text.matchAll(pattern)) {
      throw new Error(`Root-absolute URL is not Pages-subpath safe in ${file}: ${match[1]}`);
    }
  }
}

const javascript = (
  await Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFile(resolve(root, file), "utf8")),
  )
).join("\n");
if (!javascript.includes(release.version) || !javascript.includes(release.commitSha)) {
  throw new Error("Production JavaScript does not expose the sealed version and commit SHA");
}
if (!javascript.includes("audio/voice-rms-processor.js")) {
  throw new Error("Production JavaScript does not contain the Pages-relative AudioWorklet URL");
}
if (/["'`]\/audio\/voice-rms-processor\.js/.test(javascript)) {
  throw new Error("Production JavaScript contains a root-absolute AudioWorklet URL");
}

for (const page of ["privacy/index.html", "support/index.html"]) {
  const html = await readFile(resolve(root, page), "utf8");
  if (!html.includes("../release.json") || !html.includes('href="../"')) {
    throw new Error(`${page} is missing release identity or return navigation`);
  }
}

const manifestBytes = await readFile(resolve(root, ARTIFACT_MANIFEST_FILE));
const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
console.log(
  `Inspected ${files.length} production files for ${release.version} (${release.commitSha}).`,
);
console.log(`Artifact manifest SHA-256: ${manifestSha}`);

function assertTextArtifact(file, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (FORBIDDEN_REFERENCE_SHA256.has(digest)) {
    throw new Error(`Reference screenshot bytes found in production artifact: ${file}`);
  }
  for (const signature of BINARY_SIGNATURES) {
    if (
      signature.bytes.every((byte, index) => bytes[index] === byte) ||
      (signature.label === "ID3 media" &&
        bytes.subarray(0, 64).includes(Buffer.from(signature.bytes)))
    ) {
      throw new Error(`${signature.label} content disguised as release text: ${file}`);
    }
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    throw new Error(`MP4 media content disguised as release text: ${file}`);
  }

  let suspiciousControls = 0;
  for (const byte of bytes) {
    if (byte === 0 || (byte < 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      suspiciousControls += 1;
    }
  }
  if (suspiciousControls > 0) {
    throw new Error(`Binary control bytes found in production artifact: ${file}`);
  }
}

function assertNoEncodedMedia(file, text) {
  const chunks = Array.from(
    text.matchAll(/["'`]([A-Za-z0-9+/]{32,}={0,2})["'`]/g),
    (match) => match[1],
  ).filter((chunk) => !ALLOWED_PHASER_BASE64_FRAGMENTS.has(chunk));
  if (chunks.length === 0) {
    return;
  }

  for (let start = 0; start < chunks.length; start += 1) {
    let encoded = "";
    for (let end = start; end < chunks.length; end += 1) {
      encoded += chunks[end];
      assertEncodedCandidate(file, encoded);
      if (encoded.length >= 64 * 1_024) {
        break;
      }
    }
  }
}

function assertEncodedCandidate(file, encoded) {
  const decoded = decodeBase64(encoded);
  const digest = createHash("sha256").update(decoded).digest("hex");
  const mediaSignature = BINARY_SIGNATURES.some((signature) =>
    signature.bytes.every((byte, index) => decoded[index] === byte),
  );
  if (
    encoded.length >= 64 * 1_024 ||
    decoded.byteLength >= 64 * 1_024 ||
    mediaSignature ||
    FORBIDDEN_REFERENCE_SHA256.has(digest)
  ) {
    throw new Error(`Large encoded payload found in production artifact: ${file}`);
  }
}

function assertNoUnapprovedImageData(file, text) {
  if (!/data:image\//i.test(text)) {
    return;
  }

  const candidates = file.endsWith(".js")
    ? collectJavaScriptImageData(file, text)
    : collectTextImageData(text);
  for (const candidate of candidates) {
    if (candidate === "data:image/svg+xml,") {
      // Phaser's SVG loader creates this prefix at runtime from fetched SVG
      // text. The empty prefix itself contains no bundled image payload.
      continue;
    }
    const comma = candidate.indexOf(",");
    if (comma < 0) {
      throw new Error(`Malformed embedded image data found in production artifact: ${file}`);
    }
    const metadata = candidate.slice(5, comma).split(";");
    const mime = metadata.shift()?.toLowerCase();
    const parameters = metadata.map((parameter) => parameter.toLowerCase());
    const payload = candidate.slice(comma + 1);
    if (!mime?.startsWith("image/")) {
      throw new Error(`Malformed embedded image data found in production artifact: ${file}`);
    }

    let decoded;
    if (parameters.includes("base64")) {
      decoded = decodeBase64(payload);
    } else {
      try {
        decoded = Buffer.from(decodeURIComponent(payload), "utf8");
      } catch {
        throw new Error(`Malformed embedded image data found in production artifact: ${file}`);
      }
    }
    const digest = createHash("sha256").update(decoded).digest("hex");
    if (mime !== "image/png" || ALLOWED_PHASER_IMAGE_DATA.get(digest) !== decoded.byteLength) {
      throw new Error(
        `Unapproved embedded image data found in production artifact: ${file} ` +
          `(${mime ?? "unknown"}, ${decoded.byteLength} bytes, SHA-256 ${digest})`,
      );
    }
  }
}

function collectTextImageData(text) {
  return Array.from(text.matchAll(/data:image\/[^\s"'`()<>]*/gi), (match) => match[0]);
}

function collectJavaScriptImageData(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const values = new Set();

  visit(source, [new Map()]);

  const imageValues = [...values].filter((value) => /data:image\//i.test(value));
  return imageValues.filter(
    (value) =>
      !imageValues.some(
        (other) => other !== value && other.length > value.length && other.startsWith(value),
      ),
  );

  function visit(node, scopes) {
    let activeScopes = scopes;
    if (ts.isFunctionLike(node)) {
      const local = new Map();
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          local.set(parameter.name.text, null);
        }
      }
      activeScopes = [...scopes, local];
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      activeScopes.at(-1).set(node.name.text, evaluateString(node.initializer, activeScopes));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      setBinding(activeScopes, node.left.text, evaluateString(node.right, activeScopes));
    }

    if (ts.isExpression(node)) {
      const value = evaluateString(node, activeScopes);
      if (value?.includes("data:image/")) {
        for (const candidate of collectTextImageData(value)) {
          values.add(candidate);
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, activeScopes));
  }
}

function evaluateString(node, scopes) {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return evaluateString(node.expression, scopes);
  }
  if (ts.isIdentifier(node)) {
    return getBinding(scopes, node.text);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateString(node.left, scopes);
    const right = evaluateString(node.right, scopes);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluateString(span.expression, scopes);
      if (expression === null) {
        return null;
      }
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function getBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      return scopes[index].get(name);
    }
  }
  return null;
}

function setBinding(scopes, name, value) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      scopes[index].set(name, value);
      return;
    }
  }
  scopes.at(-1).set(name, value);
}

function decodeBase64(encoded) {
  if (encoded.length === 0 || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return Buffer.alloc(0);
  }
  return Buffer.from(encoded, "base64");
}
