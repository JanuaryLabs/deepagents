export function requestSignal(
  ...[input, init]: Parameters<typeof globalThis.fetch>
): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}
