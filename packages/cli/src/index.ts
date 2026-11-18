// The executable is src/bin.ts. record, eval and cache arrive in later milestones.
export { run, type CliResult, type RunOptions } from "./cli.js";
export {
  GUARD_USAGE,
  parseGuardArgs,
  runGuard,
  type GuardDeps,
  type GuardOptions,
} from "./guard/command.js";
export {
  analyse,
  classifyPath,
  type AnalyseOptions,
  type FileCategory,
} from "./guard/analyse.js";
export { GitError, GuardError, UsageError } from "./guard/errors.js";
export {
  memoryReader,
  openGitRepo,
  type ChangeStatus,
  type FileChange,
  type GitReaderOptions,
  type GitRepo,
  type RepoReader,
} from "./guard/git.js";
export {
  buildReport,
  exitCodeFor,
  formatHuman,
  formatJson,
} from "./guard/report.js";
export type {
  FailOn,
  Finding,
  FindingKind,
  GuardReport,
  GuardSummary,
  Severity,
} from "./guard/types.js";
