import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentPath, AgentThread } from '@deepagents/experimental/zukhruf';

test('agent threads round-trip the reserved metadata without disturbing other fields', () => {
  const thread = new AgentThread({
    conversation: { chatId: 'child-chat', userId: 'user-1' },
    treeId: 'root-chat',
    path: AgentPath.parse('/root/reviewer'),
    parentChatId: 'root-chat',
    declarationName: 'reviewer',
    lastTurnId: 'turn-1',
  });
  const metadata = thread.toMetadata({
    application: 'preserved',
    zukhruf: { extension: 'preserved' },
  });

  assert.deepEqual(metadata, {
    application: 'preserved',
    zukhrufTreeId: 'root-chat',
    zukhruf: {
      extension: 'preserved',
      path: '/root/reviewer',
      parentChatId: 'root-chat',
      declarationName: 'reviewer',
      lastTurnId: 'turn-1',
    },
  });

  const restored = AgentThread.fromMetadata(thread.conversation, metadata);
  assert.equal(restored?.conversation.chatId, 'child-chat');
  assert.equal(restored?.path.toString(), '/root/reviewer');
  assert.equal(restored?.lastTurnId, 'turn-1');
});

test('agent threads reject malformed reserved metadata', () => {
  assert.equal(
    AgentThread.fromMetadata(
      { chatId: 'child-chat', userId: 'user-1' },
      {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: '/root/../reviewer',
          parentChatId: 'root-chat',
          declarationName: 'reviewer',
        },
      },
    ),
    undefined,
  );

  for (const metadata of [
    {
      zukhrufTreeId: 'other-tree',
      zukhruf: {
        path: '/root',
        parentChatId: null,
        declarationName: 'root',
      },
    },
    {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root',
        parentChatId: 'victim-chat',
        declarationName: 'root',
      },
    },
    {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/reviewer',
        parentChatId: null,
        declarationName: 'reviewer',
      },
    },
  ]) {
    assert.equal(
      AgentThread.fromMetadata(
        { chatId: 'root-chat', userId: 'user-1' },
        metadata,
      ),
      undefined,
    );
  }

  assert.throws(
    () =>
      new AgentThread({
        conversation: { chatId: 'root-chat', userId: 'user-1' },
        treeId: 'other-tree',
        path: AgentPath.root(),
        parentChatId: null,
        declarationName: 'root',
      }),
    /root agent thread treeId must match its chatId/,
  );

  assert.throws(
    () =>
      new AgentThread({
        conversation: { chatId: 'child-chat', userId: 'user-1' },
        treeId: 'root-chat',
        path: AgentPath.parse('/root/reviewer'),
        parentChatId: 'child-chat',
        declarationName: 'reviewer',
      }),
    /child agent thread cannot parent itself/,
  );
});

test('agent threads reject non-canonical persisted paths', () => {
  assert.equal(
    AgentThread.fromMetadata(
      { chatId: 'child-chat', userId: 'user-1' },
      {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: ' /root/reviewer ',
          parentChatId: 'root-chat',
          declarationName: 'reviewer',
        },
      },
    ),
    undefined,
  );
});
