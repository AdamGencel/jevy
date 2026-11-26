import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The skill file is what a coding agent reads before it works on a project
 * that uses Jevy. It ships in the package, so these tests pin the two things
 * that matter: it stays short, and it names the commands that exist.
 */

const skill = readFileSync(
  new URL("../skill/SKILL.md", import.meta.url),
  "utf8",
);
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("the skill file", () => {
  it("is at most 40 lines, because long instruction files cost more and help less", () => {
    const lines = skill.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.length).toBeGreaterThan(10);
  });

  it("starts with the name and description an agent uses to pick it", () => {
    expect(skill).toMatch(/^---\nname: jevy\ndescription: .{20,}\n---\n/);
  });

  it("gives the exact commands", () => {
    expect(skill).toContain("jevy guard --base origin/main --merge-base");
    expect(skill).toContain("--json");
    expect(skill).toContain("jevy hook stop");
    expect(skill).toContain("jevy hook pre-edit");
  });

  it("states the rules: no weakened test, ask before a protected path, a fix is a diff", () => {
    expect(skill).toMatch(/Never weaken a test/);
    expect(skill).toMatch(/Ask before touching a protected path/);
    expect(skill).toMatch(/diff for a person to approve/);
  });

  it("says where the report is and what the exit codes mean", () => {
    expect(skill).toMatch(/## Where the report is/);
    expect(skill).toMatch(/0 clean, 1 findings/);
  });

  it("ships in the package", () => {
    expect(manifest).toMatchObject({
      files: expect.arrayContaining(["dist", "skill"]) as unknown,
    });
  });
});
