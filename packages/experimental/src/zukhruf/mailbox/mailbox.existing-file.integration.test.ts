import { Sqlite } from '@zukhruf/testing/sqlite';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  InterAgentCommunicationTypes,
  SqliteMailboxStore,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

const sqlite = new Sqlite();

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };

describe('SqliteMailboxStore on an existing file', () => {
  it('rebuilds tables that differ from the declaration and keeps their rows', async () => {
    await using database = await sqlite.database();
    database.connection.close();
    const completion = createInterAgentCommunication({
      id: 'child-completion:stream-consumed',
      type: InterAgentCommunicationTypes.FinalAnswer,
      author: researcher,
      recipient: root,
      content: 'finished once',
    });
    {
      using previous = new SqliteMailboxStore(database.path);
      await previous.enqueue(completion);
      await previous.drain(root);
      await previous.enqueue(
        createInterAgentCommunication({
          author: root,
          recipient: researcher,
          content: 'pending before',
        }),
      );
      await previous.beginTurn(researcher, 'turn-1');
    }
    // No release made these tables. The store writes the rows, then the
    // tables are changed by hand, to see the store bring each table up to its
    // declaration: zukhruf_mailbox_items and
    // zukhruf_mailbox_consumed_terminal_ids get one extra nullable column, and
    // zukhruf_mailbox_activity loses its PRIMARY KEY, which the ON CONFLICT of
    // beginTurn needs.
    {
      using connection = new DatabaseSync(database.path);
      connection.exec(`
ALTER TABLE zukhruf_mailbox_items ADD COLUMN note TEXT;
ALTER TABLE zukhruf_mailbox_consumed_terminal_ids ADD COLUMN note TEXT;
CREATE TABLE activity_rows AS SELECT * FROM zukhruf_mailbox_activity;
DROP TABLE zukhruf_mailbox_activity;
CREATE TABLE zukhruf_mailbox_activity (
  recipient_chat_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL
);
INSERT INTO zukhruf_mailbox_activity SELECT * FROM activity_rows;
DROP TABLE activity_rows;
`);
    }

    using store = new SqliteMailboxStore(database.path);
    const enqueued = await store.enqueue(
      createInterAgentCommunication({
        author: root,
        recipient: researcher,
        content: 'sent after',
      }),
    );
    await store.enqueue(completion);
    const ended = await store.endTurn(researcher, 'turn-1');
    await store.beginTurn(researcher, 'turn-2');
    await store.beginTurn(researcher, 'turn-3');

    assert.deepStrictEqual(enqueued, { recipientActive: true });
    assert.deepStrictEqual(ended, { hasPending: true, turnEnded: true });
    assert.deepStrictEqual(await store.drain(root), []);
    assert.deepStrictEqual(
      (await store.drain(researcher)).map(({ content }) => content),
      ['pending before', 'sent after'],
    );
    assert.deepStrictEqual(await store.endTurn(researcher, 'turn-3'), {
      hasPending: false,
      turnEnded: true,
    });
  });
});
