import { type UIMessage } from 'ai';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  type MessageFragment,
  XmlRenderer,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

function encodedMessage(
  text: string,
  options: { id: string; role?: UIMessage['role'] },
): UIMessage {
  return {
    id: options.id,
    role: options.role ?? 'assistant',
    parts: [{ type: 'text', text }],
  };
}

function codecBackedMessageFragment(message: UIMessage): MessageFragment {
  return {
    id: message.id,
    name: message.role,
    data: 'STALE_MESSAGE_DATA',
    type: 'message',
    persist: true,
    codec: {
      encode() {
        return message;
      },
      decode() {
        return message;
      },
    },
  };
}

describe('ContextEngine resolve/save with codec-backed messages', () => {
  it('resolve() uses codec.encode() for pending message fragments', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'codec-chat',
      userId: 'codec-user',
    });
    const message = encodedMessage('Fresh pending text', {
      id: 'pending-msg-1',
    });

    engine.set(codecBackedMessageFragment(message));

    const result = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    assert.deepStrictEqual(result.messages, [message]);
  });

  it('save() persists codec.encode() output for message fragments', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'codec-chat',
      userId: 'codec-user',
    });
    const message = encodedMessage('Fresh persisted text', {
      id: 'persisted-msg-1',
    });

    engine.set(codecBackedMessageFragment(message));
    await engine.save();

    const branch = await store.getActiveBranch('codec-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    assert.strictEqual(chain.length, 1);
    assert.deepStrictEqual(chain[0].data, message);

    const resolved = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    assert.deepStrictEqual(resolved.messages, [message]);
  });

  it('resolve() rejects malformed persisted message data', async () => {
    const store = new InMemoryContextStore();
    const writer = new ContextEngine({
      store,
      chatId: 'codec-chat-invalid',
      userId: 'codec-user',
    });

    await writer.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    const branch = await store.getActiveBranch('codec-chat-invalid');
    assert.ok(branch);

    await store.addMessage({
      id: 'invalid-msg-1',
      chatId: 'codec-chat-invalid',
      parentId: null,
      name: 'user',
      type: 'message',
      data: { not: 'a-ui-message' },
      createdAt: Date.now(),
    });
    await store.updateBranchHead(branch.id, 'invalid-msg-1');

    const reader = new ContextEngine({
      store,
      chatId: 'codec-chat-invalid',
      userId: 'codec-user',
    });

    const sandbox = await createVirtualAgentSandbox();
    await assert.rejects(
      reader.resolve({ renderer: new XmlRenderer(), sandbox }),
      /Stored message "invalid-msg-1" is not a UIMessage/,
    );
  });
});
