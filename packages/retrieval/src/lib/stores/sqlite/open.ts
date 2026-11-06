import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import * as sqliteVec from 'sqlite-vec';

// The store's statements use the vec0 module, so every connection that runs
// them, the dev database of the declaration included, loads sqlite-vec. The
// rows of vectors are large, so a new file gets 32 KiB pages; the write-ahead
// log fixes the page size, so the journal sets it before it.
export function openWithVectors(path: string) {
  const db = open(path, {
    allowExtension: true,
    journal: new WriteAheadLog({ pageSize: 32768 }),
  });
  db.loadExtension(sqliteVec.getLoadablePath());
  return db;
}
