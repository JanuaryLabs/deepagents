CREATE TABLE IF NOT EXISTS "chats" (
	"id" VARCHAR PRIMARY KEY,
	"title" VARCHAR,
	"userId" VARCHAR
);

CREATE TABLE IF NOT EXISTS "messages" (
	"id" VARCHAR PRIMARY KEY,
	"chatId" VARCHAR NOT NULL REFERENCES "chats" ("id") ON DELETE CASCADE,
	"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"role" VARCHAR NOT NULL,
	"content" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "messages_chat_id_idx" ON "messages" ("chatId");

CREATE INDEX IF NOT EXISTS "messages_chat_id_created_at_idx" ON "messages" ("chatId", "createdAt");
