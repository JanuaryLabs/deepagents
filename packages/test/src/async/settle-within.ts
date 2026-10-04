export async function settleWithin<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  using _timer = globalThis.setTimeout(
    () => timeout.reject(new Error(`timed out waiting for: ${label}`)),
    timeoutMs,
  );
  return await Promise.race([promise, timeout.promise]);
}
