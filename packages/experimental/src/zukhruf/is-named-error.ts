/**
 * Each subpath entry (./zukhruf/http, ./zukhruf/schedules/http) bundles its own
 * copy of a main-entry error class, so `instanceof` fails across entries; the
 * class's literal `name` is what survives. Import the class with `import type`.
 */
export function isNamedError<NamedError extends Error>(
  error: unknown,
  name: NamedError['name'],
): error is NamedError {
  return Error.isError(error) && error.name === name;
}
