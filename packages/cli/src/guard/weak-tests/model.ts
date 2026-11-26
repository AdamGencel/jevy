import type ts from "typescript";

/**
 * The shapes the weak-test modules pass between them: what reading a body
 * finds, what an assertion is made of, and the facts read once per file.
 * Also the one question every module asks of those facts: is a name the
 * framework's own?
 */

/** Why an assertion's outcome is fixed before the code under test runs. */
export type ConstantOutcome = "literals" | "self" | "fixture";

/**
 * Whether an assertion on constants passes. Only `passes` makes it one that
 * cannot fail: one that fails when reached is how a test marks a line that
 * must not run, and `unknown` may be either.
 */
export type FixedResult = "passes" | "fails" | "unknown";

/** An assertion whose outcome the code under test cannot change. */
export interface Constant {
  readonly outcome: ConstantOutcome;
  readonly result: FixedResult;
}

/** What a test body shows beyond its own `expect` chains. */
export interface BodyEvidence {
  /**
   * A function in this file, which the body calls, has an assertion that can
   * fail. An advisory one (see `helperAdvisory`) is not one of these.
   */
  readonly helperAsserts: boolean;
  /**
   * A function in this file, which the body calls, has an advisory check:
   * `@jevyjs/playwright`'s `toSatisfy`, or a `toPass` block whose only check
   * is one. Kept apart from `helperAsserts` because, while `toSatisfy` does
   * not block, such a check cannot fail the build: counted as an assertion,
   * it would silence the test it is meant to describe.
   */
  readonly helperAdvisory?: true;
  /** The assertions on constants in the same-file functions the body calls. */
  readonly helperConstants: readonly Constant[];
  /** Code used by the body that the guard cannot read, in source order, each once. */
  readonly unseen: readonly string[];
  /** The body, or a same-file function it calls, has a `throw` statement. */
  readonly throws: boolean;
  /**
   * The body checks in a way no matcher shows: it calls `fail()` or
   * `unreachable()`, counts assertions with `expect.assertions()` or
   * `expect.hasAssertions()`, or uses a `done`-style callback.
   */
  readonly checksByHand: boolean;
  /**
   * A hook (`afterEach`) around the test, or a fixture definition
   * (`test.extend`) in the file, may check: it has an assertion that can
   * fail, throws, or uses code the guard cannot read.
   */
  readonly hookChecks: boolean;
  /**
   * A hook around the test has an advisory check (see `helperAdvisory`) and
   * nothing else that may check: it is no place a real check may hide while
   * `toSatisfy` does not block, and it is one when it does.
   */
  readonly hookAdvisory?: true;
  /**
   * The test is defined with a `test` or `it` that the file imports from its
   * own code or builds itself, so fixtures the guard cannot see may run
   * around it and the built-in ones may have been replaced.
   */
  readonly customRunner: boolean;
  /**
   * The body tests types: it calls `expectTypeOf` or `assertType`, has a
   * `@ts-expect-error` directive, or sits in a type-test file
   * (`*.test-d.ts`), which never runs. A `type`, an `interface` or
   * `satisfies` alone does not count: one token must not silence a test.
   */
  readonly typeLevel: boolean;
  /**
   * The body reads a row of its `.each` table, or a parameter of a
   * parameterised describe around it. Rows can make a constant-looking
   * assertion real, so only then are the constant and mock rules left out.
   */
  readonly readsRows: boolean;
  /** Mocks the body creates and only calls itself, by name. */
  readonly ownMocks: readonly string[];
}

/** The parts of `expect(subject).not.matcher(args)`, as the parser read them. */
export interface AssertionParts {
  readonly matcher: string;
  /** True when the chain has an odd number of `.not`. */
  readonly negated: boolean;
  /** `poll`, `resolves` and `rejects`; `.not` is not one. */
  readonly modifiers: readonly string[];
  readonly subject: ts.Expression | undefined;
  readonly args: readonly ts.Expression[];
}

export type Primitive = string | number | boolean | null | undefined;

/**
 * A value the guard can work out from the source alone. `opaque` is a
 * constant it does not evaluate (a regular expression, a bigint, an operator
 * it does not model): fixed, but with a result it cannot tell.
 */
export type Known =
  | { readonly kind: "primitive"; readonly value: Primitive }
  | {
      readonly kind: "list";
      readonly text: string | null;
      readonly length: number;
    }
  | { readonly kind: "record"; readonly text: string | null }
  | { readonly kind: "fixture" }
  | { readonly kind: "opaque" };

/** The names of one function that an assertion on constants can be made of. */
export interface AssertionScope {
  /** `const` names bound once to a constant, with its value. */
  readonly literals: ReadonlyMap<string, Known>;
  /** Parameters that hold a built-in fixture object, which is always there. */
  readonly fixtures: ReadonlySet<string>;
  /**
   * Matcher names the file passes to `expect.extend`. Such a name is the
   * project's own code there, even when it is a built-in one like `toBe`.
   */
  readonly customMatchers: ReadonlySet<string>;
}

/** The scope of an assertion outside any test: no names are known. */
export const NO_SCOPE: AssertionScope = {
  literals: new Map(),
  fixtures: new Set(),
  customMatchers: new Set(),
};

/** How a test is defined, as far as it decides what its parameters are. */
export interface TestShape {
  /** The name the chain starts with: `test`, `it`, `xit`. */
  readonly root: string;
  /** True for `.each`: the parameters are rows of the table, not fixtures. */
  readonly rows: boolean;
}

export type Fn =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/**
 * A named function, and the function or file it is declared in. Only a
 * function declaration with a body, or a `const` bound to a function, and
 * only when nothing in the file assigns to the name: anything else may hold
 * other code by the time a test calls it.
 */
export interface Helper {
  readonly fn: Fn;
  readonly scope: ts.Node;
  /** The name as it is declared. */
  readonly name: ts.Identifier;
}

/** One thing reading a helper found, in the order it was found. */
export type HelperStep =
  | { readonly kind: "helper"; readonly helper: Helper }
  | { readonly kind: "unseen"; readonly name: string }
  | { readonly kind: "constant"; readonly constant: Constant };

/**
 * What one helper shows on its own, read once per file: it does not depend
 * on the test that calls it. Calls to other helpers are steps, followed
 * when a test reaches it.
 */
export interface HelperReading {
  readonly steps: readonly HelperStep[];
  /** It has an assertion that can fail, advisory ones aside. */
  readonly asserts: boolean;
  /** It has an advisory check (see `BodyEvidence.helperAdvisory`). */
  readonly advises: boolean;
  readonly throws: boolean;
  readonly checksByHand: boolean;
  readonly typeLevel: boolean;
}

/**
 * Everything a helper reaches, read once per file: each helper it reaches,
 * first reached first, and the steps that are not calls, with the helper
 * each came from. A test that has already read some of these helpers skips
 * their steps, which gives what reading them afresh would.
 */
export interface HelperClosure {
  readonly helpers: readonly Fn[];
  readonly steps: readonly {
    readonly from: Fn;
    readonly step: Exclude<HelperStep, { readonly kind: "helper" }>;
  }[];
}

/**
 * Readings kept for the whole file, so each is made once however many tests
 * use it. Without them a file with many helpers was read once per test.
 */
export interface FileMemo {
  /** Names each function declares in its own scope. */
  readonly scopeNames: WeakMap<ts.Node, readonly string[]>;
  readonly readings: WeakMap<Fn, HelperReading>;
  readonly closures: WeakMap<Fn, HelperClosure>;
  /** The arguments of every call of a helper, or null when it is used otherwise. */
  readonly callSites: WeakMap<Fn, readonly (readonly ts.Expression[])[] | null>;
}

/** A hook or fixture definition, and the function or file it applies to. */
export interface Hook {
  readonly scope: ts.Node;
  readonly mayCheck: boolean;
  /** It has an advisory check (see `BodyEvidence.hookAdvisory`). */
  readonly advises: boolean;
}

/** What the rules need to know about the whole file, read once. */
export interface FileFacts {
  /** Reads an `expect(…).matcher(…)` call; the parser owns that grammar. */
  readonly readAssertion: (call: ts.CallExpression) => AssertionParts | null;
  /** Functions defined in the file, by name. A name can have more than one. */
  readonly helpers: ReadonlyMap<string, readonly Helper[]>;
  /** The same helpers, by function. */
  readonly helperOf: ReadonlyMap<Fn, Helper>;
  /** Every name the file assigns to, anywhere: `x = …`, `x++`, `[x] = …`. */
  readonly assigned: ReadonlySet<string>;
  /** Matcher names the file passes to `expect.extend` in an object literal. */
  readonly customMatchers: ReadonlySet<string>;
  /**
   * `toSatisfy` here is `@jevyjs/playwright`'s, which only reports while it
   * does not block: the file imports `expect` from that package under its
   * own name and does not define a `toSatisfy` with `expect.extend`. Any
   * other `toSatisfy` is an ordinary matcher: Vitest's checks a predicate
   * exactly, Playwright's own `expect` has none and throws, and an `expect`
   * from a local file may be anything.
   */
  readonly jevyToSatisfy: boolean;
  /** The file is a type-test file (`*.test-d.ts`), which is never run. */
  readonly typeOnly: boolean;
  /**
   * Names the file imports or declares at module level. Such a name is not
   * the global of the same name, and a local that reuses it is not trusted,
   * because the two sets of names a body is read with are not scoped.
   */
  readonly moduleNames: ReadonlySet<string>;
  /** The module each imported or required name comes from. */
  readonly imports: ReadonlyMap<string, string>;
  /** Module-level `const`s built only from literals and other such constants. */
  readonly constants: ReadonlySet<string>;
  readonly hooks: readonly Hook[];
  readonly memo: FileMemo;
}

/**
 * Modules whose `test`, `it`, `expect` and hooks are the framework's own. A
 * `test` from anywhere else (`./fixtures`, `base.extend(…)`) can bring
 * fixtures that check around every test, and can replace the built-in ones.
 *
 * `@jevyjs/playwright` is Playwright's `test` and `expect`, extended with
 * `toSatisfy` and fixtures that check nothing, and its built-in fixtures are
 * Playwright's. Without it here, an empty test written with Jevy's `test`
 * would be `assertion-not-visible` instead of `test-without-assertion`.
 */
const FRAMEWORKS = new Set([
  "@playwright/test",
  "@jevyjs/playwright",
  "vitest",
  "@jest/globals",
]);

/**
 * True when `name` is the framework's own: a global, or imported from one of
 * `modules`. A name the file imports from elsewhere or declares is not.
 */
export function fromFramework(
  name: string,
  facts: FileFacts,
  modules: ReadonlySet<string> = FRAMEWORKS,
): boolean {
  if (!facts.moduleNames.has(name)) {
    return true;
  }
  const source = facts.imports.get(name);
  return source !== undefined && modules.has(source);
}

/**
 * Testing Library's `cleanup`: it unmounts what a test rendered and asserts
 * nothing. The one well-known cleanup import trusted in a hook; anything
 * else a hook calls from another file may check.
 */
export function isQuietImport(name: string, facts: FileFacts): boolean {
  return (
    name === "cleanup" &&
    facts.imports.get(name)?.startsWith("@testing-library/") === true
  );
}
