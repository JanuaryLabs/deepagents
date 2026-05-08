export const DEFAULT_POSTGRES_STREAM_CHANGES_CHANNEL =
  'deepagents_stream_changes';

export function postgresStreamNotifyDDL(
  schema: string,
  channel = DEFAULT_POSTGRES_STREAM_CHANGES_CHANNEL,
): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE OR REPLACE FUNCTION "${schema}"."notify_stream_chunks_insert"()
RETURNS TRIGGER AS $$
DECLARE
  changed_stream_id TEXT;
BEGIN
  FOR changed_stream_id IN
    SELECT DISTINCT stream_id FROM new_rows
  LOOP
    PERFORM pg_notify(
      '${channel}',
      json_build_object(
        'schema', TG_TABLE_SCHEMA,
        'streamId', changed_stream_id,
        'kind', 'chunks'
      )::text
    );
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "stream_chunks_notify_insert"
AFTER INSERT ON "${schema}"."stream_chunks"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "${schema}"."notify_stream_chunks_insert"();

CREATE OR REPLACE FUNCTION "${schema}"."notify_stream_status_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_notify(
      '${channel}',
      json_build_object(
        'schema', TG_TABLE_SCHEMA,
        'streamId', NEW.id,
        'kind', 'status'
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "streams_notify_status_update"
AFTER UPDATE OF status ON "${schema}"."streams"
FOR EACH ROW
EXECUTE FUNCTION "${schema}"."notify_stream_status_update"();
`;
}
