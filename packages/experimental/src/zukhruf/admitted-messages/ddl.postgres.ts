export function admittedMessagesDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."zukhruf_admitted_messages" (
  turn_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  digest TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "zukhruf_admitted_messages_chat"
  ON "${schema}"."zukhruf_admitted_messages" (chat_id);
`;
}
