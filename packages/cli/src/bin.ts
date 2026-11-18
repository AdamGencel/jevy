#!/usr/bin/env node
import { run } from "./cli.js";
import { readPackageVersion } from "./version.js";

const version = readPackageVersion(new URL("../package.json", import.meta.url));
const result = await run(process.argv.slice(2), version);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
// Set the code rather than calling process.exit, so output piped to another
// process (a large --json report in CI) is flushed before Node exits.
process.exitCode = result.code;
