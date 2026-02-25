import { BigQuery as BigQueryClient } from '@google-cloud/bigquery';

import {
  BigQuery,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '../src/lib/adapters/bigquery/index.ts';

const PROJECT_ID = 'january-9f554';
const PUBLIC_PROJECT = 'bigquery-public-data';
const DATASET = 'thelook_ecommerce';

const client = new BigQueryClient({
  projectId: PROJECT_ID,
});

async function execute(sql: string) {
  const [rows] = await client.query({ query: sql, location: 'US' });
  return rows;
}

async function validate(sql: string) {
  try {
    await client.createQueryJob({
      query: sql,
      dryRun: true,
      location: 'US',
    });
    return undefined;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

const adapter = new BigQuery({
  execute,
  validate,
  datasets: [DATASET],
  projectId: PUBLIC_PROJECT,
  grounding: [
    info(),
    tables({ forward: true }),
    views(),
    constraints(),
    // rowCount() uses TABLE_STORAGE which isn't accessible on cross-project public datasets
    indexes(),
  ],
});

// async function main() {
//   console.log(
//     `Introspecting ${PUBLIC_PROJECT}.${DATASET}...\n`,
//   );

//   const start = performance.now();
//   const fragments = await adapter.introspect();
//   const elapsed = ((performance.now() - start) / 1000).toFixed(1);

//   console.log(`Found ${fragments.length} fragments in ${elapsed}s:\n`);

//   for (const f of fragments) {
//     if (f.name === 'table') {
//       const cols = f.data.columns?.length ?? 0;
//       const rows = f.data.rowCount ?? '?';
//       const size = f.data.sizeHint ?? '';
//       console.log(
//         `  TABLE: ${f.data.name} (${rows} rows, ${cols} columns, ${size})`,
//       );
//       for (const col of f.data.columns ?? []) {
//         const annotations = [
//           col.data.pk && 'PK',
//           col.data.fk && `FK→${col.data.fk}`,
//           col.data.notNull && 'NOT NULL',
//           col.data.indexed && 'INDEXED',
//           col.data.unique && 'UNIQUE',
//         ]
//           .filter(Boolean)
//           .join(', ');
//         console.log(
//           `    ${col.data.name} ${col.data.type}${annotations ? ` [${annotations}]` : ''}`,
//         );
//       }
//       if (f.data.indexes?.length) {
//         for (const idx of f.data.indexes) {
//           console.log(
//             `    INDEX: ${idx.data.name} (${idx.data.type ?? 'BTREE'}) on [${idx.data.columns.join(', ')}]`,
//           );
//         }
//       }
//       console.log();
//     } else if (f.name === 'view') {
//       console.log(`  VIEW: ${f.data.name}`);
//     } else if (f.name === 'relationship') {
//       console.log(
//         `  REL: ${f.data.from.table}(${f.data.from.columns.join(',')}) → ${f.data.to.table}(${f.data.to.columns.join(',')}) [${f.data.cardinality ?? 'unknown'}]`,
//       );
//     } else if (f.name === 'dialectInfo') {
//       console.log(`  DIALECT: ${JSON.stringify(f.data)}`);
//     } else {
//       console.log(`  ${f.name}: ${JSON.stringify(f.data).slice(0, 120)}`);
//     }
//   }

//   console.log('\n--- Validation Test ---');
//   const validResult = await adapter.validate(
//     `SELECT * FROM \`${PUBLIC_PROJECT}.${DATASET}.users\` LIMIT 5`,
//   );
//   console.log(`Valid query: ${validResult === undefined ? 'PASSED' : validResult}`);

//   const invalidResult = await adapter.validate(
//     `SELECT * FROM \`${PUBLIC_PROJECT}.${DATASET}.nonexistent_table\``,
//   );
//   console.log(`Invalid query: ${invalidResult ? 'CAUGHT' : 'MISSED (should have failed)'}`);

//   console.log('\n--- Query Execution Test ---');
//   const rows = await adapter.execute(
//     `SELECT id, first_name, last_name, email FROM \`${PUBLIC_PROJECT}.${DATASET}.users\` LIMIT 3`,
//   );
//   console.log('Sample users:');
//   for (const row of rows) {
//     console.log(`  ${JSON.stringify(row)}`);
//   }
// }

// main().catch(console.error);
