import { dirname, resolve } from "node:path";
import type { HookDeps } from "./deps.js";
import { printable } from "./text.js";

/**
 * What the hooks do when the directory they run in has no `jevy.config.*`
 * but the repository has one somewhere else.
 *
 * The hooks read the config of the project directory. Started one directory
 * off (at the root of a monorepo whose config is in `packages/app`), they
 * would find none, run no check and protect only the built-in paths, and
 * say nothing. So they look for a tracked config elsewhere and fail closed
 * when there is one.
 */

export interface ConfigElsewhere {
  /** The first tracked config, relative to the project directory. */
  readonly path: string;
  /** How many other tracked configs there are. */
  readonly more: number;
  /** The directory of `path`: what `--cwd` should be. */
  readonly cwd: string;
}

/**
 * The tracked config outside `projectDir`, or null when there is none. Call
 * it only when `projectDir` has no config of its own. A tracked config
 * directly in `projectDir` does not count: it has been deleted from the
 * working tree, which the stop hook reports as a change to the config.
 * Rejects when git cannot list the files.
 */
export async function configElsewhere(
  projectDir: string,
  deps: HookDeps,
): Promise<ConfigElsewhere | null> {
  const tracked = await deps.git.trackedConfigs(projectDir);
  const others = tracked.filter((path) => path.includes("/"));
  const first = others[0];
  return first === undefined
    ? null
    : {
        path: first,
        more: others.length - 1,
        cwd: resolve(projectDir, dirname(first)),
      };
}

/** "<dir> has no jevy.config.*, but the repository has <path>", for a reason. */
export function elsewhereText(
  projectDir: string,
  found: ConfigElsewhere,
): string {
  const more = found.more === 0 ? "" : ` (and ${String(found.more)} more)`;
  return `${printable(projectDir)} has no jevy.config.*, but the repository has ${printable(found.path)}${more}`;
}
