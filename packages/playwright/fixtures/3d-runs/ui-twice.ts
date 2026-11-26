import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import process from "node:process";

// Two runs of tests/repeated.spec.ts by one Playwright TestRunner in one
// process, as the UI mode, watch mode and the VS Code extension run tests:
// the output directory is kept between runs and the worker processes have
// the same parent. TestRunner is Playwright's internal API (checked on
// 1.63), so this script is a test tool, not something Jevy relies on.
// Usage: node ui-twice.ts <playwright.config.ts>

interface TestRunnerLike {
  initialize(options: object): Promise<unknown>;
  runTests(
    reporter: object,
    params: { readonly locations: readonly string[] },
  ): Promise<{ readonly status: string }>;
  stop(): Promise<unknown>;
}

type TestRunnerClass = new (
  location: unknown,
  options: object,
) => TestRunnerLike;

const configFile = process.argv[2];
if (configFile === undefined) throw new Error("Name the Playwright config");

const require = createRequire(import.meta.url);
const testPackage = realpathSync(
  dirname(require.resolve("@playwright/test/package.json")),
);
const load = (path: string): unknown =>
  require(require.resolve(path, { paths: [testPackage] }));
const runner = load("playwright/lib/runner") as {
  readonly testRunner: { readonly TestRunner: TestRunnerClass };
};
const common = load("playwright/lib/common") as {
  readonly configLoader: {
    readonly resolveConfigLocation: (file: string) => unknown;
  };
};

const testRunner = new runner.testRunner.TestRunner(
  common.configLoader.resolveConfigLocation(configFile),
  {},
);
await testRunner.initialize({});
const statuses: string[] = [];
for (let run = 1; run <= 2; run += 1) {
  const { status } = await testRunner.runTests(
    { version: () => "v2" },
    { locations: ["tests/repeated.spec.ts"] },
  );
  statuses.push(status);
}
await testRunner.stop();
process.stdout.write(`${JSON.stringify({ statuses })}\n`);
process.exit(0);
