// The executable is src/bin.ts. The app map, admission, cache and eval arrive in later steps.
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
export {
  CONFIG_FILENAMES,
  findConfig,
  readConfigSettings,
  type ConfigSettings,
} from "./guard/config-source.js";
export { checkGlob, firstMatch, matchesGlob } from "./guard/glob.js";
export {
  buildProtectRules,
  protectedPathFindings,
  protectionOf,
  type Protection,
  type ProtectRules,
} from "./guard/protect.js";
export { HOOK_USAGE, runHook, type HookDeps } from "./hook/command.js";
export { claudeSettings, type ClaudeSettings } from "./hook/print.js";
