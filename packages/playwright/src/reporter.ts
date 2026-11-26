import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { ConfigError } from "@jevyjs/core";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { buildReport, serialiseReport } from "./report/build.js";
import type { ReportAttempt, ReportTest } from "./report/build.js";
import {
  REPORT_ATTACHMENT_CONTENT_TYPE,
  REPORT_ATTACHMENT_NAME,
  ReportError,
  parseReportEntry,
} from "./report/schema.js";
import type { JevyReport, ReportAssertion } from "./report/schema.js";

/** Where `report.json` goes under the Jevy root, unless `outputFile` says otherwise. */
export const DEFAULT_REPORT_PATH = "jevy-report/report.json";

/**
 * Options from `reporter: [["@jevyjs/playwright/reporter", { … }]]`.
 * `outputFile`: the report's path, relative to the Jevy root unless absolute.
 * `root`: the Jevy root, relative to the working directory unless absolute.
 * Without it the root is the Playwright config file's directory, or `rootDir`
 * when there is no config file: the rule the matcher uses for `spec`.
 */
export interface JevyReporterOptions {
  readonly outputFile?: string;
  readonly root?: string;
  /**
   * Playwright's own `_mode` key: `"list"` under `playwright test --list`,
   * where no test runs, so there is nothing to report and the last real
   * report must be left alone.
   */
  readonly listOnly?: boolean;
}

/**
 * Collects the entries the matcher attaches and writes `report.json`.
 *
 * Entries travel from workers as attachments, so no worker writes the file
 * and parallel runs cannot race on it. The reporter only reports: it never
 * returns a status from `onEnd` and never throws, so it cannot change the
 * run's outcome. Whether a verdict failed a test was decided in the worker
 * and arrives as each entry's `effect`.
 *
 * A malformed entry is a Jevy defect, not a verdict. It fails the report, not
 * the run: no file is written, a stale one is removed so nobody reads last
 * run's results as this run's, and the reason goes to stderr.
 *
 * Everything it prints goes to stderr: stdout belongs to reporters such as
 * `--reporter=json`, whose output a line from Jevy would corrupt.
 */
export default class JevyReporter implements Reporter {
  private readonly options: JevyReporterOptions;
  private outputPath: string | undefined;
  private root: string | undefined;
  private readonly attempts: ReportAttempt[] = [];
  private readonly problems: string[] = [];
  /** Attempts begun and not yet ended, so `onEnd` can find the unfinished. */
  private readonly running = new Map<TestResult, TestCase>();

  /**
   * Playwright merges its own keys (`configDir`, `_mode`, `_commandHash`)
   * into the options, so keys other than ours are ignored, not refused.
   */
  public constructor(options?: unknown) {
    this.options = parseOptions(options);
  }

  public onBegin(config: FullConfig): void {
    if (this.options.listOnly === true) return;
    this.root = resolveRoot(this.options, config);
    this.outputPath = resolveReportPath(this.options, config);
  }

  public onTestBegin(test: TestCase, result: TestResult): void {
    if (this.options.listOnly === true) return;
    this.running.set(result, test);
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    if (this.options.listOnly === true) return;
    this.running.delete(result);
    this.record(test, result, result.status);
  }

  public async onEnd(result: FullResult): Promise<void> {
    if (this.options.listOnly === true) return;
    // Playwright 1.63 ends a run on a global timeout without calling
    // onTestEnd for the tests still running. Their results hold what they
    // attached so far; they count as interrupted, never as finished.
    for (const [unfinished, test] of this.running) {
      this.record(test, unfinished, "interrupted");
    }
    this.running.clear();
    const path = this.outputPath;
    if (path === undefined) {
      writeLine(
        process.stderr,
        "Jevy: report.json was not written: the reporter was never started",
      );
      return;
    }
    try {
      if (this.problems.length > 0) {
        throw new ReportError(this.problems.join("\n"));
      }
      const report = buildReport(this.attempts, { status: result.status });
      await writeReplacing(path, serialiseReport(report));
      process.stderr.write(summaryLine(report, path, process.cwd()));
    } catch (error) {
      await removeStale(path);
      writeLine(
        process.stderr,
        `Jevy: report.json was not written (${path}):\n${messageOf(error)}`,
      );
    }
  }

  private record(
    test: TestCase,
    result: TestResult,
    status: TestResult["status"],
  ): void {
    const root = this.root;
    if (root === undefined) return;
    try {
      this.attempts.push({
        testId: test.id,
        retry: result.retry,
        status,
        test: identityOf(test, root),
        entries: entriesOf(test, result),
      });
    } catch (error) {
      this.problems.push(`${describeTest(test)}: ${messageOf(error)}`);
    }
  }

  /**
   * False, so that when this is the only reporter Playwright still adds its
   * own terminal output. One summary line is all this reporter prints.
   */
  public printsToStdio(): boolean {
    return false;
  }
}

/**
 * The Jevy root: the `root` option, else the config file's directory, else
 * `rootDir`. The matcher's `spec` is relative to the same directory.
 */
function resolveRoot(options: JevyReporterOptions, config: FullConfig): string {
  return options.root !== undefined
    ? resolve(options.root)
    : config.configFile !== undefined
      ? dirname(config.configFile)
      : config.rootDir;
}

/** The report's absolute path: `outputFile` resolved against the Jevy root. */
export function resolveReportPath(
  options: JevyReporterOptions,
  config: FullConfig,
): string {
  return resolve(
    resolveRoot(options, config),
    options.outputFile ?? DEFAULT_REPORT_PATH,
  );
}

/**
 * One line for the terminal. The path is relative to the working directory
 * when it is inside it, so it can be pasted; otherwise absolute.
 */
export function summaryLine(
  report: Pick<JevyReport, "run" | "summary">,
  path: string,
  cwd: string,
): string {
  const { summary } = report;
  const total = summary.pass + summary.fail + summary.needsReview;
  const fromCwd = relative(cwd, path);
  const shown =
    fromCwd === "" || fromCwd.startsWith("..") || isAbsolute(fromCwd)
      ? path
      : fromCwd;
  return (
    `Jevy: ${String(total)} ${total === 1 ? "assertion" : "assertions"}: ` +
    `${String(summary.pass)} pass, ${String(summary.fail)} fail, ` +
    `${String(summary.needsReview)} needs-review; ` +
    `${String(summary.failedTest)} failed its test; ` +
    `${String(summary.incomplete)} incomplete. ` +
    `Run ${report.run.status}. Report: ${shown}\n`
  );
}

function parseOptions(options: unknown): JevyReporterOptions {
  if (options === undefined) return {};
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new ConfigError("Jevy reporter options must be an object");
  }
  const fields = options as Readonly<Record<string, unknown>>;
  const outputFile = optionalPath(fields, "outputFile");
  const root = optionalPath(fields, "root");
  return {
    ...(outputFile !== undefined ? { outputFile } : {}),
    ...(root !== undefined ? { root } : {}),
    // Playwright 1.63 merges `_mode: "list" | "test" | "merge"` into every
    // reporter's options (`reporterCommandOptions` in its runner).
    ...(fields["_mode"] === "list" ? { listOnly: true } : {}),
  };
}

function optionalPath(
  fields: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  if (!Object.hasOwn(fields, name)) return undefined;
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(
      `Jevy reporter option ${name} must be a non-empty string`,
    );
  }
  return value;
}

/** Parse every `jevy-assertion` attachment of one attempt, or throw. */
function entriesOf(test: TestCase, result: TestResult): ReportAssertion[] {
  const project = test.parent.project()?.name ?? "";
  return result.attachments
    .filter((one) => one.name === REPORT_ATTACHMENT_NAME)
    .map((one) => {
      if (one.contentType !== REPORT_ATTACHMENT_CONTENT_TYPE) {
        throw new ReportError(
          `A ${REPORT_ATTACHMENT_NAME} attachment must be ${REPORT_ATTACHMENT_CONTENT_TYPE}`,
        );
      }
      if (one.body === undefined) {
        throw new ReportError(
          `A ${REPORT_ATTACHMENT_NAME} attachment has no body`,
        );
      }
      const entry = parseReportEntry(decodeUtf8(one.body));
      if (entry.project !== project) {
        throw new ReportError(
          "A report entry's project is not the project its test ran in",
        );
      }
      return entry;
    });
}

/**
 * The test as `incomplete` names it, from Playwright's own data: the file
 * relative to the Jevy root with forward slashes, as the matcher's `spec`,
 * and the describe titles, leaving out anonymous describes, whose title is
 * empty. A file outside the root gives a spec the report refuses, which
 * fails the report only if that test is listed as incomplete.
 */
function identityOf(test: TestCase, root: string): ReportTest {
  return {
    spec: relative(root, test.location.file).split(sep).join("/"),
    project: test.parent.project()?.name ?? "",
    test: [...describeTitles(test.parent), test.title],
    line: test.location.line,
  };
}

function describeTitles(suite: Suite | undefined): readonly string[] {
  if (suite?.type !== "describe") return [];
  const outer = describeTitles(suite.parent);
  return suite.title === "" ? outer : [...outer, suite.title];
}

/** Fatal decoding: a replacement character would hide a corrupted entry. */
function decodeUtf8(body: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ReportError("A report entry is not valid UTF-8");
  }
}

/** The test's file, line and titles: code, never page text. */
function describeTest(test: TestCase): string {
  const { file, line } = test.location;
  return `${file}:${String(line)} ${test.titlePath().filter(Boolean).join(" › ")}`;
}

/**
 * Write the report to a temporary file beside it, then rename it over the
 * target. A reader never sees half a report, and `rename` replaces a
 * directory entry rather than following it, so a symbolic link planted at
 * the path cannot redirect the write. A symbolic link or anything else that
 * is not a regular file at the path is refused outright, so it is reported
 * rather than silently replaced.
 */
async function writeReplacing(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await assertReplaceable(path);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Absent or a regular file; anything else throws `ReportError`. */
async function assertReplaceable(path: string): Promise<void> {
  const kind = await entryKind(path);
  if (kind === "symlink") {
    throw new ReportError(`${path} is a symbolic link; it was left alone`);
  }
  if (kind === "other") {
    throw new ReportError(`${path} is not a regular file; it was left alone`);
  }
}

async function entryKind(
  path: string,
): Promise<"absent" | "file" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Remove last run's report so it is not read as this run's. Only a regular
 * file is removed: a symbolic link or a directory at the path is not ours to
 * delete. Either case, and a failure to remove, is said on stderr, not
 * thrown: the reporter never fails the run.
 */
async function removeStale(path: string): Promise<void> {
  try {
    const kind = await entryKind(path);
    if (kind === "absent") return;
    if (kind !== "file") {
      writeLine(
        process.stderr,
        `Jevy: a stale report was not removed (${path}): it is not a regular file`,
      );
      return;
    }
    await rm(path, { force: true });
  } catch (error) {
    writeLine(
      process.stderr,
      `Jevy: a stale report could not be removed (${path}): ${messageOf(error)}`,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}
