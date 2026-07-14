import { writeFile } from 'node:fs/promises';

import { SqliteApprovalMutex } from '@deepagents/experimental/zukhruf';

const databasePath = process.argv[2];
const markerPath = process.argv[3];
if (!databasePath || !markerPath) {
  throw new Error('approval mutex fixture requires database and marker paths');
}

using mutex = new SqliteApprovalMutex(databasePath);
await mutex.runExclusive('fixture-chat', async () => {
  process.send?.({ type: 'locked' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await writeFile(markerPath, 'released');
});
