import { type UIMessage, convertToModelMessages } from 'ai';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  type ContextStore,
  InMemoryContextStore,
  XmlRenderer,
  assistant,
  createBashTool,
  createVirtualSandbox,
  user,
} from '@deepagents/context';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

function newRequest(store: ContextStore) {
  return new ContextEngine({
    store,
    chatId: 'reasoning-dup',
    userId: 'test-user',
  });
}

const REUSED_ITEM_ID = 'rs_reused_across_a_client_tool_round_trip';

// Mirrors the real production shape (Limerence/Thea chat c329399c, openai:gpt-5.5):
// one OpenAI reasoning item spans a client-tool round-trip, so the streamed
// assistant message holds two reasoning parts that share the same openai.itemId,
// one per step. assistant() should normalise this away before it is stored.
function turnSpanningToolRoundTrip(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'reasoning',
        text: '',
        state: 'done',
        providerMetadata: {
          openai: { itemId: REUSED_ITEM_ID, reasoningEncryptedContent: null },
        },
      },
      {
        type: 'tool-readFile',
        toolCallId: 'call_readfile',
        state: 'output-available',
        input: { path: 'notes.txt' },
        output: 'file contents',
      },
      { type: 'step-start' },
      {
        type: 'reasoning',
        text: '',
        state: 'done',
        providerMetadata: {
          openai: { itemId: REUSED_ITEM_ID, reasoningEncryptedContent: null },
        },
      },
      { type: 'text', text: 'Here is the answer.' },
    ] as UIMessage['parts'],
  };
}

function reasoningItemIds(
  modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>,
) {
  const ids: string[] = [];
  for (const message of modelMessages) {
    if (message.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if ((part as { type?: string }).type !== 'reasoning') continue;
      const itemId = (
        part as { providerOptions?: { openai?: { itemId?: string } } }
      ).providerOptions?.openai?.itemId;
      if (itemId) ids.push(itemId);
    }
  }
  return ids;
}

describe('reasoning that spans a client-tool round-trip', () => {
  it('is normalised before storage so replay never sends a duplicate item id', async () => {
    const store = new InMemoryContextStore();

    const writer = newRequest(store);
    const assistantId = await writer.continue(
      user({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'read notes.txt' }],
      }),
    );
    await writer.continue(assistant(turnSpanningToolRoundTrip(assistantId)));

    // A later turn replays the persisted history from the store.
    const reader = newRequest(store);
    const { messages } = await reader.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    const modelMessages = await convertToModelMessages(messages as never, {
      ignoreIncompleteToolCalls: true,
    });

    const ids = reasoningItemIds(modelMessages);
    assert.strictEqual(
      ids.length,
      new Set(ids).size,
      `reasoning item id sent ${ids.length}x but only ${new Set(ids).size} unique — OpenAI rejects duplicates with 400. ids=${JSON.stringify(ids)}`,
    );
    assert.ok(
      ids.includes(REUSED_ITEM_ID),
      'the reasoning item should still be sent once',
    );
  });
});
