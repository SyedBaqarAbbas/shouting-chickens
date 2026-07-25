import { describe, expect, it } from "vitest";

import { normalizeDeploymentDirectoryUrl } from "./deployment-url";

describe("normalizeDeploymentDirectoryUrl", () => {
  it.each(["https://example.test/shouting-chickens", "https://example.test/shouting-chickens/"])(
    "keeps relative release probes inside the project directory for %s",
    (deploymentUrl) => {
      const baseUrl = normalizeDeploymentDirectoryUrl(deploymentUrl);

      expect(baseUrl.href).toBe("https://example.test/shouting-chickens/");
      expect(new URL("release.json", baseUrl).href).toBe(
        "https://example.test/shouting-chickens/release.json",
      );
      expect(new URL("privacy/", baseUrl).href).toBe(
        "https://example.test/shouting-chickens/privacy/",
      );
    },
  );

  it("drops query and fragment state from the directory base", () => {
    expect(
      normalizeDeploymentDirectoryUrl(
        "https://example.test/shouting-chickens?deployment=123#result",
      ).href,
    ).toBe("https://example.test/shouting-chickens/");
  });
});
