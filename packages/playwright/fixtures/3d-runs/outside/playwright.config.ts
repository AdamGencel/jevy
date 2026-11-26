import { defineConfig } from "@playwright/test";
import base from "../playwright.config.js";

// The same project, loaded from this directory, so this directory is the
// Jevy root while the specs stay in ../tests: every spec is outside the root.
export default defineConfig({ ...base, testDir: "../tests" });
