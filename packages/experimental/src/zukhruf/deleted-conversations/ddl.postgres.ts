export function deletedConversationsDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE TABLE IF NOT EXISTS "${schema}"."zukhruf_deleted_conversations" (
  chat_id TEXT PRIMARY KEY,
  deleted_at BIGINT NOT NULL
);
`;
}
