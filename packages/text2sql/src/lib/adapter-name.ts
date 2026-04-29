export const ADAPTER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  }
}
