import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("production Pages workflow policy", () => {
  it("keeps publishing explicit, manual, main-only, and pinned to the current main tip", () => {
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.publish && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain('if [[ "$GITHUB_REF" != "refs/heads/main" ]]');
    expect(workflow).toContain(
      'if [[ "$(git rev-parse refs/remotes/origin/main)" != "$GITHUB_SHA" ]]',
    );
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).not.toMatch(/if:\s*github\.event_name == 'push'[\s\S]{0,120}deploy/i);
  });

  it("makes deploy and postdeploy depend on the complete sealed quality job", () => {
    const quality = requiredSection("  quality:", "  deploy:");
    for (const gate of [
      "npm audit --audit-level=low",
      "npm run format:check",
      "npm run lint",
      "npm run typecheck",
      "npm run test",
      "npm run build",
      "npm run test:e2e",
      "npm run test:e2e:compatibility",
      "npm run test:e2e:production",
      "npm run test:e2e:pwa",
      "npm run test:lighthouse",
      "npm run test:soak",
      "node scripts/inspect-build.mjs",
      "git diff --exit-code",
    ]) {
      expect(quality, gate).toContain(gate);
    }
    expect(quality.indexOf("npm run build")).toBeLessThan(
      quality.indexOf("actions/upload-pages-artifact"),
    );

    const deploy = requiredSection("  deploy:", "  postdeploy:");
    expect(deploy).toContain("needs: quality");
    expect(deploy).toContain("actions/deploy-pages@");
    expect(deploy).not.toContain("npm run build");

    const postdeploy = workflow.slice(workflow.indexOf("  postdeploy:"));
    expect(postdeploy).toMatch(/needs:\s*\n\s*- quality\s*\n\s*- deploy/);
    expect(postdeploy).toContain("npm run test:postdeploy");
  });

  it("requires separate mobile and installed-desktop candidate evidence before publishing", () => {
    const quality = requiredSection("  quality:", "  deploy:");
    expect(workflow).toContain("desktop_evidence_url:");
    expect(quality).toContain("DESKTOP_EVIDENCE_URL: ${{ inputs.desktop_evidence_url }}");
    expect(quality).toContain(
      'for evidence_url in "$IOS_EVIDENCE_URL" "$ANDROID_EVIDENCE_URL" "$DESKTOP_EVIDENCE_URL"',
    );
    expect(quality).toContain(
      'if [[ "$IOS_EVIDENCE_URL" == "$ANDROID_EVIDENCE_URL" || "$IOS_EVIDENCE_URL" == "$DESKTOP_EVIDENCE_URL" || "$ANDROID_EVIDENCE_URL" == "$DESKTOP_EVIDENCE_URL" ]]',
    );
  });

  it("pins actions and carries immutable release identity through deployment verification", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+\S+@([^\s#]+)/g)].map(
      (match) => match[1],
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[0-9a-f]{40}$/);
    }

    const quality = requiredSection("  quality:", "  deploy:");
    expect(quality).toContain("commit_sha: ${{ github.sha }}");
    expect(quality).toContain("app_version: ${{ steps.metadata.outputs.app_version }}");
    expect(quality).toContain(
      "name: mvp-${{ steps.metadata.outputs.app_version }}-${{ github.sha }}",
    );
    expect(quality).toContain('ARTIFACT_SHA="$(sha256sum dist/artifact-manifest.json');
    expect(quality).toContain('"$ARTIFACT_SHA" != "$CANDIDATE_MANIFEST_SHA"');

    const postdeploy = workflow.slice(workflow.indexOf("  postdeploy:"));
    expect(postdeploy).toContain("APP_VERSION: ${{ needs.quality.outputs.app_version }}");
    expect(postdeploy).toContain("COMMIT_SHA: ${{ needs.quality.outputs.commit_sha }}");
    expect(postdeploy).toContain(
      "ARTIFACT_MANIFEST_SHA: ${{ needs.quality.outputs.artifact_manifest_sha }}",
    );
    expect(postdeploy).toContain("DEPLOY_URL: ${{ needs.deploy.outputs.page_url }}");
  });
});

function requiredSection(start: string, end: string) {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return workflow.slice(startIndex, endIndex);
}
