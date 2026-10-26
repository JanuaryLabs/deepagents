// Mailbox schema for SQLite. SQLite stores the text of each CREATE and
// @zukhruf/sqlite-drift compares it, so the text after each object name must
// stay byte-identical to what earlier releases wrote, indentation included.

// Session-level PRAGMAs, run on each connection before the schema is applied.
export const SETUP = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
`;

export const statements = [
  `CREATE TABLE zukhruf_mailbox_items (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_chat_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    communication TEXT NOT NULL
  )`,
  `CREATE TABLE zukhruf_mailbox_activity (
    recipient_chat_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (recipient_chat_id, recipient_user_id)
  )`,
  `CREATE TABLE zukhruf_mailbox_consumed_terminal_ids (
    communication_id TEXT PRIMARY KEY
  )`,
  `CREATE INDEX zukhruf_mailbox_recipient_sequence
    ON zukhruf_mailbox_items (
      recipient_chat_id,
      recipient_user_id,
      sequence
    )`,
  // enqueue relies on this index through INSERT OR IGNORE.
  `CREATE UNIQUE INDEX zukhruf_mailbox_communication_id
    ON zukhruf_mailbox_items (
      json_extract(communication, '$.id')
    )`,
];
