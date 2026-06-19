export const ADAPTER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Tag name used to label each adapter's configured connection name inside its
 * indexed schema fragment (see `databaseNameFragment` in adapter-index.ts).
 * Reserved as an adapter name: an adapter literally named `database` would make
 * the label tag indistinguishable from the wrapper tag and render nested
 * `<database><database>…</database></database>`.
 */
export const DATABASE_NAME_FRAGMENT = 'database';

const RESERVED_ADAPTER_NAMES = new Set<string>([DATABASE_NAME_FRAGMENT]);

export function isValidAdapterName(
  name: string | null | undefined,
): name is string {
  return name != null && ADAPTER_NAME_PATTERN.test(name);
}

export function validateAdapterNames(names: Iterable<string>): void {
  for (const name of names) {
    if (!isValidAdapterName(name)) {
      throw new Error(
        `Invalid adapter name "${name}": must match ${ADAPTER_NAME_PATTERN}`,
      );
    }
    if (RESERVED_ADAPTER_NAMES.has(name)) {
      throw new Error(`Adapter name "${name}" is reserved`);
    }
  }
}
