import { DatabaseSync } from 'node:sqlite';

export const dbPath = '/Users/ezzabuzaid/Downloads/Chinook.db';

export default new DatabaseSync(dbPath, {
  readOnly: true,
  open: true,
});
