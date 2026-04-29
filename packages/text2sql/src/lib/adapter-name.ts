export const ADAPTER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidAdapterName(name: string): boolean {
  return ADAPTER_NAME_PATTERN.test(name);
}

export function validateAdapterNames(names: Iterable<string>): void {
  let count = 0;
  for (const name of names) {
    if (!ADAPTER_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid adapter name "${name}": must match ${ADAPTER_NAME_PATTERN}`,
      );
    }
    count++;
  }
  if (count === 0) {
    throw new Error('Text2Sql requires at least one adapter');
  }
}
