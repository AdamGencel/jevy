import type { Verdict } from "@jevyjs/core";
import { describe, expect, it } from "vitest";
import { applyPolicy, readCiContext } from "./policy.js";
import type { CiContext, PolicySettings } from "./policy.js";

const ADVISORY: PolicySettings = {
  blocking: false,
  needsReview: { pr: "warn", main: "fail" },
  mainBranch: "main",
};
const BLOCKING: PolicySettings = { ...ADVISORY, blocking: true };

const LOCAL: CiContext = { ci: false, branch: null, pullRequest: false };
const MAIN: CiContext = { ci: true, branch: "main", pullRequest: false };
const PULL_REQUEST: CiContext = { ci: true, branch: "main", pullRequest: true };
const FEATURE: CiContext = { ci: true, branch: "feature", pullRequest: false };
const UNKNOWN: CiContext = { ci: true, branch: null, pullRequest: false };

const EVERY_CONTEXT = [LOCAL, MAIN, PULL_REQUEST, FEATURE, UNKNOWN];

describe("applyPolicy", () => {
  it("a pass has no effect, blocking or not, anywhere", () => {
    for (const settings of [ADVISORY, BLOCKING]) {
      for (const ci of EVERY_CONTEXT) {
        expect(applyPolicy("pass", settings, ci)).toBe("none");
      }
    }
  });

  it("advisory: fail and needs-review are only reported, even on main in CI", () => {
    const strict: PolicySettings = {
      ...ADVISORY,
      needsReview: { pr: "fail", main: "fail" },
    };
    for (const verdict of ["fail", "needs-review"] as const) {
      for (const ci of EVERY_CONTEXT) {
        expect(applyPolicy(verdict, strict, ci)).toBe("reported");
      }
    }
  });

  it("blocking: a fail fails the assertion everywhere", () => {
    for (const ci of EVERY_CONTEXT) {
      expect(applyPolicy("fail", BLOCKING, ci)).toBe("failed");
    }
  });

  it("blocking: needs-review outside CI only warns, whatever the config says", () => {
    const strict: PolicySettings = {
      ...BLOCKING,
      needsReview: { pr: "fail", main: "fail" },
    };
    expect(applyPolicy("needs-review", strict, LOCAL)).toBe("reported");
    expect(
      applyPolicy("needs-review", strict, { ...LOCAL, branch: "main" }),
    ).toBe("reported");
  });

  it("blocking: needs-review in CI takes the main action only on the main branch outside a pull request", () => {
    expect(applyPolicy("needs-review", BLOCKING, MAIN)).toBe("failed");
    expect(applyPolicy("needs-review", BLOCKING, PULL_REQUEST)).toBe(
      "reported",
    );
    expect(applyPolicy("needs-review", BLOCKING, FEATURE)).toBe("reported");
    expect(applyPolicy("needs-review", BLOCKING, UNKNOWN)).toBe("reported");
  });

  it("blocking: the configured actions and main branch are used", () => {
    const flipped: PolicySettings = {
      blocking: true,
      needsReview: { pr: "fail", main: "warn" },
      mainBranch: "trunk",
    };
    expect(
      applyPolicy("needs-review", flipped, { ...MAIN, branch: "trunk" }),
    ).toBe("reported");
    expect(applyPolicy("needs-review", flipped, MAIN)).toBe("failed");
    expect(applyPolicy("needs-review", flipped, FEATURE)).toBe("failed");
  });

  it("refuses a verdict it does not know", () => {
    expect(() =>
      applyPolicy("maybe" as unknown as Verdict, BLOCKING, LOCAL),
    ).toThrow(/verdict/);
  });
});

describe("readCiContext", () => {
  it("CI is on when CI is set to anything but empty, 0 or false, as core's cache mode reads it", () => {
    expect(readCiContext({}).ci).toBe(false);
    for (const off of ["", "0", "false"]) {
      expect(readCiContext({ CI: off }).ci).toBe(false);
    }
    for (const on of ["1", "true", "yes"]) {
      expect(readCiContext({ CI: on }).ci).toBe(true);
    }
  });

  it("takes the branch from JEVY_BRANCH first", () => {
    expect(
      readCiContext({
        CI: "1",
        JEVY_BRANCH: "release",
        GITHUB_REF_NAME: "main",
        CI_COMMIT_BRANCH: "other",
      }),
    ).toEqual({ ci: true, branch: "release", pullRequest: false });
  });

  it("then GITHUB_REF_NAME, then CI_COMMIT_BRANCH; empty values are skipped", () => {
    expect(
      readCiContext({
        CI: "true",
        JEVY_BRANCH: "",
        GITHUB_REF_NAME: "main",
        CI_COMMIT_BRANCH: "other",
      }).branch,
    ).toBe("main");
    expect(
      readCiContext({ CI: "true", GITHUB_REF_NAME: "", CI_COMMIT_BRANCH: "gl" })
        .branch,
    ).toBe("gl");
    expect(readCiContext({ CI: "true" }).branch).toBeNull();
  });

  it("a GitHub pull_request or pull_request_target event is a pull request, whatever the branch", () => {
    for (const event of ["pull_request", "pull_request_target"]) {
      expect(
        readCiContext({
          CI: "true",
          GITHUB_REF_NAME: "main",
          GITHUB_EVENT_NAME: event,
        }).pullRequest,
      ).toBe(true);
      expect(
        readCiContext({
          CI: "true",
          JEVY_BRANCH: "main",
          GITHUB_EVENT_NAME: event,
        }).pullRequest,
      ).toBe(true);
    }
    expect(
      readCiContext({
        CI: "true",
        GITHUB_REF_NAME: "main",
        GITHUB_EVENT_NAME: "push",
      }).pullRequest,
    ).toBe(false);
  });

  it("a GitLab merge request pipeline is a pull request", () => {
    expect(
      readCiContext({ CI: "true", CI_MERGE_REQUEST_IID: "12" }).pullRequest,
    ).toBe(true);
  });
});
