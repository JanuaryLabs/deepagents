import pg from 'pg';

import {
  Postgres,
  columnStats,
  columnValues,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/postgres';

export const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? '5432'),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'pagila',
});

const pagila = new Postgres({
  execute: async (sql: string) => {
    const result = await pool.query(sql);
    return result.rows;
  },
  grounding: [
    tables(),
    views(),
    info(),
    indexes(),
    constraints(),
    rowCount(),
    columnStats(),
    columnValues(),
  ],
});

export default {
  pagila,
};
