import type { DatabaseSync } from 'node:sqlite';

export interface Table{
	name: string;
	columns: Array<{ name: string; type: string; }>;
	relationships: Array<{
		table: string;
		from: string[];
		referenced_table: string;
		to: string[];
	}>;
}

export function inspector(db: DatabaseSync) {
  const res = (
    db
      .prepare(
        `
		SELECT name
		FROM sqlite_master
		WHERE type='table'
		ORDER BY name;
	`,
      )
      .all() as Array<{ name: string | null | undefined }>
  ).filter((r) => r.name != null && !String(r.name).startsWith('sqlite_'));

  const tables = res.map((r) => {
    const tableName = String(r.name);
    const columns = (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string | null | undefined;
        type: string | null | undefined;
      }>
    ).map((col) => ({
      name: String(col.name),
      type: String(col.type),
    }));

    return {
      name: tableName,
      columns: Array.from(columns),
    };
  });

  // Collect foreign key relationships across all tables
  const relationships = res.flatMap((r) => {
    const tableName = String(r.name);
    type FKRow = {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      match?: string;
    };
    const rows = db
      .prepare(`PRAGMA foreign_key_list(${tableName})`)
      .all() as FKRow[];

    const groups = new Map<
      number,
      {
        table: string;
        from: string[];
        referenced_table: string;
        to: string[];
      }
    >();

    for (const row of rows) {
      const id = row.id;
      const existing = groups.get(id);
      if (!existing) {
        groups.set(id, {
          table: tableName,
          from: [String(row.from)],
          referenced_table: String(row.table),
          to: [String(row.to)],
        });
      } else {
        existing.from.push(String(row.from));
        existing.to.push(String(row.to));
      }
    }

    return Array.from(groups.values());
  });

  return { tables, relationships };
}
