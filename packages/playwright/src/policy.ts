import { ConfigError } from "@jevyjs/core";
import type { NeedsReviewAction, Verdict } from "@jevyjs/core";
import type { Effect } from "./report/schema.js";

/**
 * What a `toSatisfy` verdict does to its test. A pure function of the
 * verdict, three config values and the CI context, so the whole policy is
 * tested without a browser and the matcher only applies what it returns.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

/** The parts of `jevy.config.*` the policy reads. */
export interface PolicySettings {
  /** `toSatisfy.blocking`. Off by default: every verdict is only reported. */
  readonly blocking: boolean;
  /** `ci.needsReview`: what `needs-review` does in CI, once blocking is on. */
  readonly needsReview: {
    readonly pr: NeedsReviewAction;
    readonly main: NeedsReviewAction;
  };
  /** `ci.mainBranch`. */
  readonly mainBranch: string;
}

/** Where the run happens, read from the environment by `readCiContext`. */
export interface CiContext {
  readonly ci: boolean;
  /** Null when no known variable names it. */
  readonly branch: string | null;
  readonly pullRequest: boolean;
}

/**
 * `none` on a pass. Advisory (the default): everything else is `reported`,
 * because model-judged checks are not yet measured well enough to gate a
 * merge. Blocking: a `fail` fails the assertion; `needs-review` only warns
 * outside CI, where a person is at the keyboard to look, and in CI takes the
 * `main` action on the main branch outside a pull request and the `pr`
 * action otherwise, including when the branch is unknown.
 */
export function applyPolicy(
  verdict: Verdict,
  settings: PolicySettings,
  ci: CiContext,
): Effect {
  switch (verdict) {
    case "pass":
      return "none";
    case "fail":
      return settings.blocking ? "failed" : "reported";
    case "needs-review": {
      if (!settings.blocking || !ci.ci) return "reported";
      const onMain =
        !ci.pullRequest &&
        ci.branch !== null &&
        ci.branch === settings.mainBranch;
      const action = onMain
        ? settings.needsReview.main
        : settings.needsReview.pr;
      return action === "fail" ? "failed" : "reported";
    }
    default:
      throw new ConfigError(
        `toSatisfy got an unknown verdict ${JSON.stringify(verdict)}`,
      );
  }
}

const GITHUB_PULL_REQUEST_EVENTS: readonly string[] = [
  "pull_request",
  "pull_request_target",
];

/**
 * CI is on as core's cache mode reads it: `CI` set to anything but empty,
 * `0` or `false`. The branch comes from `JEVY_BRANCH` (the explicit
 * override, for any CI), then GitHub's `GITHUB_REF_NAME`, then GitLab's
 * `CI_COMMIT_BRANCH`; empty values are skipped.
 *
 * A pull request is read from GitHub's `GITHUB_EVENT_NAME` and GitLab's
 * `CI_MERGE_REQUEST_IID`, whichever variable named the branch: a run for a
 * pull request into main must never take main's action, and on GitHub the
 * ref name of a pull request is `<number>/merge`, not a branch.
 */
export function readCiContext(env: Environment): CiContext {
  const flag = env["CI"];
  const ci =
    flag !== undefined && flag !== "" && flag !== "0" && flag !== "false";
  const branch =
    present(env["JEVY_BRANCH"]) ??
    present(env["GITHUB_REF_NAME"]) ??
    present(env["CI_COMMIT_BRANCH"]) ??
    null;
  const event = env["GITHUB_EVENT_NAME"];
  const pullRequest =
    (event !== undefined && GITHUB_PULL_REQUEST_EVENTS.includes(event)) ||
    present(env["CI_MERGE_REQUEST_IID"]) !== undefined;
  return { ci, branch, pullRequest };
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
