export type ReleaseInfo = {
  readonly version: string;
  readonly commitSha: string;
  readonly shortCommitSha: string;
};

const normalizedCommitSha = __COMMIT_SHA__.trim() || "development";

export const RELEASE_INFO: ReleaseInfo = Object.freeze({
  version: __APP_VERSION__.trim() || "0.0.0",
  commitSha: normalizedCommitSha,
  shortCommitSha:
    normalizedCommitSha === "development" ? normalizedCommitSha : normalizedCommitSha.slice(0, 7),
});
