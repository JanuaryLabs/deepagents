CREATE TABLE IF NOT EXISTS "teachables" (
	"id" VARCHAR PRIMARY KEY,
	"userId" VARCHAR,
	"type" VARCHAR NOT NULL,
	"data" TEXT NOT NULL,
	"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "teachables_user_id_idx" ON "teachables" ("userId");

CREATE INDEX IF NOT EXISTS "teachables_type_idx" ON "teachables" ("type");

CREATE INDEX IF NOT EXISTS "teachables_user_type_idx" ON "teachables" ("userId", "type");
