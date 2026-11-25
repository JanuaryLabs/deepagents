// SQLite stores the text of each CREATE and @zukhruf/sqlite-drift compares
// it, so the text after each object name must stay byte-identical to what
// earlier releases wrote, indentation included.

export const statements = [
  `CREATE TABLE zukhruf_deleted_conversations (
    chat_id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  )`,
];
