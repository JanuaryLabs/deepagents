export function extractPathParams(path: string): string[] {
  const names: string[] = [];
  const re = /{([^}]+)}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    names.push(match[1]);
  }
  return names;
}

export interface UnsafePathParam {
  field: string;
  reason: string;
}

const UNSAFE_CHARS = /[/\\?#&]/;
const CONTROL = /[\x00-\x1f\x7f]/;
const PRE_ENCODED = /%[0-9a-fA-F]{2}/;

export function findUnsafePathParam(
  input: unknown,
  names: string[],
): UnsafePathParam | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;

  for (const name of names) {
    const value = record[name];
    if (typeof value !== 'string') continue;

    if (value.length === 0) {
      return { field: name, reason: 'is empty' };
    }
    if (value === '.' || value === '..') {
      return {
        field: name,
        reason: `resolves to '${value}' path segment`,
      };
    }
    const unsafeChar = value.match(UNSAFE_CHARS);
    if (unsafeChar) {
      return {
        field: name,
        reason: `contains disallowed character '${unsafeChar[0]}'`,
      };
    }
    if (CONTROL.test(value)) {
      return { field: name, reason: 'contains a control character' };
    }
    const encoded = value.match(PRE_ENCODED);
    if (encoded) {
      return {
        field: name,
        reason: `contains pre-encoded sequence '${encoded[0]}'`,
      };
    }
  }
  return null;
}
