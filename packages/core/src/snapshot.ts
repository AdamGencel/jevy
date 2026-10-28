/**
 * One node of an accessibility snapshot.
 *
 * The shape matches the structured tree Playwright returns from an
 * accessibility snapshot. `@jevyjs/core` does not depend on Playwright; the
 * plugin (later) passes that tree in. YAML aria snapshots are not accepted.
 * Screenshots are intentionally absent.
 */
export interface AccessibilityNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string | number;
  readonly description?: string;
  readonly keyshortcuts?: string;
  readonly roledescription?: string;
  readonly valuetext?: string;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly focused?: boolean;
  readonly modal?: boolean;
  readonly multiline?: boolean;
  readonly multiselectable?: boolean;
  readonly readonly?: boolean;
  readonly required?: boolean;
  readonly selected?: boolean;
  readonly checked?: boolean | "mixed";
  readonly pressed?: boolean | "mixed";
  readonly level?: number;
  readonly valuemin?: number;
  readonly valuemax?: number;
  readonly autocomplete?: string;
  readonly haspopup?: string;
  readonly invalid?: string;
  readonly orientation?: string;
  readonly children?: readonly AccessibilityNode[];
}

/**
 * A subtree to hash or send. `name` is matched after the same text
 * normalisation as the tree, so a volatile timestamp in the name still matches.
 * The first preorder match wins. A miss throws, rather than silently hashing
 * the whole page.
 */
export interface SnapshotRegion {
  readonly role: string;
  readonly name?: string;
}

/** Built-in text normalisations a project can turn off individually. */
export type NormaliseBuiltin =
  "uuid" | "timestamp" | "relative-time" | "long-digits";

export interface NormaliseReplacement {
  readonly pattern: RegExp;
  readonly placeholder: string;
}

/**
 * Partial normalisation settings. Omitted fields use the defaults.
 * `dropRoles` is added to the built-in roles (`none`, `presentation`);
 * it does not replace them.
 */
export interface NormaliseOverrides {
  readonly disable?: readonly NormaliseBuiltin[];
  readonly replace?: readonly NormaliseReplacement[];
  readonly dropRoles?: readonly string[];
  readonly unwrapUnnamedGeneric?: boolean;
}

export interface NormaliseOptions {
  readonly disable: readonly NormaliseBuiltin[];
  readonly replace: readonly NormaliseReplacement[];
  readonly dropRoles: readonly string[];
  readonly unwrapUnnamedGeneric: boolean;
}

export const DEFAULT_DROP_ROLES: readonly string[] = ["none", "presentation"];

export const DEFAULT_NORMALISE: NormaliseOptions = {
  disable: [],
  replace: [],
  dropRoles: DEFAULT_DROP_ROLES,
  unwrapUnnamedGeneric: true,
};

export function resolveNormalise(
  overrides: NormaliseOverrides | undefined,
): NormaliseOptions {
  const extraRoles = overrides?.dropRoles ?? [];
  const dropRoles = [...DEFAULT_DROP_ROLES];
  for (const role of extraRoles) {
    if (!dropRoles.includes(role)) dropRoles.push(role);
  }
  return {
    disable: overrides?.disable ?? DEFAULT_NORMALISE.disable,
    replace: overrides?.replace ?? DEFAULT_NORMALISE.replace,
    dropRoles,
    unwrapUnnamedGeneric:
      overrides?.unwrapUnnamedGeneric ?? DEFAULT_NORMALISE.unwrapUnnamedGeneric,
  };
}
