// SQLite stores the text of each CREATE and @zukhruf/sqlite-drift compares
// it, so the text after each object name must stay byte-identical to what
// earlier releases wrote, indentation included.

export const statements = [
  `CREATE TABLE zukhruf_admitted_messages (
    turn_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    digest TEXT NOT NULL
  )`,
  `CREATE INDEX zukhruf_admitted_messages_chat
    ON zukhruf_admitted_messages (chat_id)`,
];
