/**
 * Codec for encoding/decoding fragments.
 *
 * Methods use `this` to access fragment data:
 * ```ts
 * codec: {
 *   decode() { return { role: 'user', content: String(this.data) }; },
 *   encode() { return this.data; },
 * }
 * ```
 */
export interface FragmentCodec<TData = unknown> {
  decode(): unknown;
  /** Convert fragment to storage format (for DB) */
  encode(): unknown;
}
