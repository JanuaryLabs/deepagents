export function mailboxDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."zukhruf_mailbox_items" (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  communication_id TEXT NOT NULL UNIQUE,
  recipient_chat_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  communication JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS "zukhruf_mailbox_recipient_sequence"
  ON "${schema}"."zukhruf_mailbox_items" (recipient_chat_id, recipient_user_id, sequence);

CREATE TABLE IF NOT EXISTS "${schema}"."zukhruf_mailbox_activity" (
  recipient_chat_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY (recipient_chat_id, recipient_user_id)
);

CREATE TABLE IF NOT EXISTS "${schema}"."zukhruf_mailbox_consumed_terminal_ids" (
  communication_id TEXT PRIMARY KEY
);
`;
}
