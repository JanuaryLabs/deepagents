import assert from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryContextStore } from '@deepagents/context';

describe('Message Upsert', () => {
  it('should update existing message with same ID', async () => {
    const store = new InMemoryContextStore();

    // Need to create chat first due to foreign key constraint
    await store.upsertChat({ id: 'chat-1', userId: 'user-1' });

    // Insert first message
    await store.addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      parentId: null,
      name: 'user',
      type: 'message',
      data: { text: 'Original content' },
      createdAt: 1000,
    });

    // Insert a second message to use as parent
    await store.addMessage({
      id: 'msg-2',
      chatId: 'chat-1',
      parentId: 'msg-1',
      name: 'assistant',
      type: 'message',
      data: { text: 'Response' },
      createdAt: 1500,
    });

    // Upsert msg-1 with different content (parentId stays null since msg-2 references it)
    await store.addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      parentId: null,
      name: 'assistant', // Changed from 'user'
      type: 'message',
      data: { text: 'Updated content' }, // Changed from 'Original content'
      createdAt: 2000, // Different timestamp - should NOT be updated
    });

    const msg = await store.getMessage('msg-1');
    assert.ok(msg);

    // Should have updated data
    assert.deepStrictEqual(msg.data, { text: 'Updated content' });
    assert.strictEqual(msg.name, 'assistant');
    assert.strictEqual(msg.parentId, null);

    // Should preserve original createdAt
    assert.strictEqual(msg.createdAt, 1000);
  });

  it('should update FTS index on upsert', async () => {
    const store = new InMemoryContextStore();

    // Need to create chat first for FTS search to work
    await store.upsertChat({ id: 'chat-1', userId: 'user-1' });

    // Insert first message
    await store.addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      parentId: null,
      name: 'user',
      type: 'message',
      data: 'original searchable content',
      createdAt: 1000,
    });

    // Search should find original content
    let results = await store.searchMessages('chat-1', 'original');
    assert.strictEqual(results.length, 1);

    // Upsert with new content
    await store.addMessage({
      id: 'msg-1',
      chatId: 'chat-1',
      parentId: null,
      name: 'user',
      type: 'message',
      data: 'updated searchable content',
      createdAt: 1000,
    });

    // Search for original should NOT find it anymore
    results = await store.searchMessages('chat-1', 'original');
    assert.strictEqual(results.length, 0);

    // Search for updated should find it
    results = await store.searchMessages('chat-1', 'updated');
    assert.strictEqual(results.length, 1);
  });
});
