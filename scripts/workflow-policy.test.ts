import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const recoveryDeploy = readFileSync(".github/workflows/deploy-current-main.yml", "utf8");
const workflows = `${ci}\n${recoveryDeploy}`;

describe("production Pages workflow policy", () => {
  it("runs a short deterministic quality gate before automatic main deployment", () => {
    expect(ci).toContain("name: CI and deploy");
    expect(ci).toContain("paths-ignore:");
    expect(ci).toContain('".github/workflows/**"');
    expect(ci).toContain('"scripts/workflow-policy.test.ts"');

    const quality = requiredSection(ci, "  quality:", "  deploy:");
    for (const gate of [
      "npm run format:check",
      "npm run lint",
      "npm run typecheck",
      "npm run test",
      "npm run build",
      "npm run test:e2e:production",
    ]) {
      expect(quality).toContain(gate);
    }
    expect(quality).toContain("npm ci --no-audit --fund=false");
    expect(quality.indexOf("Record release identity")).toBeLessThan(
      quality.indexOf("Build and seal production artifact"),
    );
    for (const removedGate of [
      "Validate physical-device evidence gate",
      "npm audit --audit-level=low",
      "npm run test:e2e:compatibility",
      "npm run test:e2e:pwa",
      "npm run test:lighthouse",
      "npm run test:soak",
    ]) {
      expect(quality).not.toContain(removedGate);
    }

    const deploy = requiredSection(ci, "  deploy:", "  postdeploy:");
    expect(deploy).toContain("needs: quality");
    expect(deploy).toContain("actions/deploy-pages@");
    expect(deploy).toContain("github.event_name == 'push'");
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
  });

  it("keeps the recovery deploy separate from CI and verifies it after release", () => {
    expect(recoveryDeploy).toContain("workflow_dispatch:");
    expect(recoveryDeploy).toContain("ref: main");
    expect(recoveryDeploy).toContain("npm ci --no-audit --fund=false");
    expect(recoveryDeploy).toContain("npm run build");
    expect(recoveryDeploy.indexOf("Record release identity")).toBeLessThan(
      recoveryDeploy.indexOf("Build and seal production artifact"),
    );
    expect(recoveryDeploy).toContain("actions/deploy-pages@");
    expect(recoveryDeploy).toContain("npm run test:postdeploy");
    expect(recoveryDeploy).not.toContain("Validate physical-device evidence gate");
  });

  it("removes physical-device and candidate-artifact release blockers", () => {
    for (const obsoleteValue of [
      "inputs.publish",
      "ios_evidence_url",
      "android_evidence_url",
      "desktop_evidence_url",
      "candidate_manifest_sha",
      "CANDIDATE_MANIFEST_SHA",
      "Validate physical-device evidence gate",
    ]) {
      expect(workflows).not.toContain(obsoleteValue);
    }
  });

  it("uses immutable action revisions", () => {
    const actionReferences = [...workflows.matchAll(/uses:\s+\S+@([^\s#]+)/g)].map(
      (match) => match[1],
    );

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

function requiredSection(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
