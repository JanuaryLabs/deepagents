import { type Text2Sql } from './sql.ts';

/**
 * Resolve a requested `<db>` token to a configured adapter name. Shared by the
 * virtual-sandbox `sql` command and the `sql` CLI so both surfaces behave
 * identically:
 * - exact match → that name
 * - no match but exactly one adapter configured → route to it (silently)
 * - otherwise → throw with the user-facing "unknown database" message
 *
 * `db` is assumed non-empty; callers handle the missing-argument case (their
 * usage strings differ).
 */
export function resolveAdapter(text2Sql: Text2Sql, db: string): string {
  if (text2Sql.hasAdapter(db)) return db;
  const names = text2Sql.adapterNames();
  if (names.length === 1) return names[0];
  const available = names.join(', ') || '(none configured)';
  throw new Error(`unknown database "${db}". Available: ${available}`);
}
