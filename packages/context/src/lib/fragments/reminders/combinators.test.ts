import type { ToolUIPart, UIMessage } from 'ai';
import { generateId } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type WhenContext,
  afterTurn,
  and,
  anyToolCalled,
  contentIncludes,
  everyNTurns,
  everyOfLastN,
  first,
  firstN,
  not,
  or,
  toolCalled,
  withinLastN,
} from '@deepagents/context';

function wctx(
  partial: Partial<WhenContext> & { turn: number; content: string },
): WhenContext {
  return {
    branch: 'main',
    chat: { id: 'test-chat', userId: 'test-user', createdAt: 0, updatedAt: 0 },
    messageCount: 0,
    currentMessage: {
      id: 'test-msg',
      role: 'user',
      parts: [{ type: 'text', text: partial.content }],
    },
    ...partial,
  };
}

describe('and', () => {
  it('combines with AND logic', async () => {
    const pred = and(everyNTurns(3), afterTurn(5));
    assert.strictEqual(await pred(wctx({ turn: 3, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 6, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 7, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 9, content: '' })), true);
  });
});

describe('or', () => {
  it('combines with OR logic', async () => {
    const pred = or(first(), everyNTurns(5));
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 5, content: '' })), true);
    assert.strictEqual(await pred(wctx({ turn: 10, content: '' })), true);
  });
});

describe('not', () => {
  it('inverts a predicate', async () => {
    const pred = not(firstN(2));
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 2, content: '' })), false);
    assert.strictEqual(await pred(wctx({ turn: 3, content: '' })), true);
  });
});

function assistantWithTool(toolName: string): UIMessage {
  const part: ToolUIPart = {
    type: `tool-${toolName}`,
    toolCallId: generateId(),
    state: 'input-available',
    input: {},
  };
  return {
    id: generateId(),
    role: 'assistant',
    parts: [part],
  };
}

function assistantTextOnly(text: string): UIMessage {
  return {
    id: generateId(),
    role: 'assistant',
    parts: [{ type: 'text', text }],
  };
}

describe('withinLastN', () => {
  it('fires when match is anywhere in the last N assistant messages', async () => {
    const history: UIMessage[] = [
      assistantTextOnly('thinking'),
      assistantWithTool('bash'),
      assistantTextOnly('reply'),
      assistantTextOnly('done'),
    ];
    const pred = withinLastN(3, toolCalled('bash'));
    assert.strictEqual(
      await pred(
        wctx({ turn: 5, content: '', lastAssistantMessages: history }),
      ),
      true,
    );
  });

  it('does NOT fire when match is outside the window', async () => {
    const history: UIMessage[] = [
      assistantWithTool('bash'),
      assistantTextOnly('a'),
      assistantTextOnly('b'),
      assistantTextOnly('c'),
    ];
    const pred = withinLastN(3, toolCalled('bash'));
    assert.strictEqual(
      await pred(
        wctx({ turn: 5, content: '', lastAssistantMessages: history }),
      ),
      false,
    );
  });

  it('is existential: fires when ANY one of last N matches (not a streak)', async () => {
    const mostlyTools: UIMessage[] = [
      assistantWithTool('bash'),
      assistantWithTool('bash'),
      assistantTextOnly('text only'),
    ];
    const pred = withinLastN(3, not(anyToolCalled()));
    assert.strictEqual(
      await pred(
        wctx({ turn: 5, content: '', lastAssistantMessages: mostlyTools }),
      ),
      true,
    );
  });

  it('returns false when lastAssistantMessages is undefined or empty', async () => {
    const pred = withinLastN(3, toolCalled('bash'));
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), false);
    assert.strictEqual(
      await pred(wctx({ turn: 1, content: '', lastAssistantMessages: [] })),
      false,
    );
  });

  it('composes with and / or', async () => {
    const history: UIMessage[] = [
      assistantTextOnly('a'),
      assistantWithTool('bash'),
    ];
    const pred = and(afterTurn(2), withinLastN(2, toolCalled('bash')));
    assert.strictEqual(
      await pred(
        wctx({ turn: 3, content: '', lastAssistantMessages: history }),
      ),
      true,
    );
    assert.strictEqual(
      await pred(
        wctx({ turn: 1, content: '', lastAssistantMessages: history }),
      ),
      false,
    );
  });

  it('returns false when n <= 0 even with full history', async () => {
    const history: UIMessage[] = [
      assistantWithTool('bash'),
      assistantWithTool('bash'),
    ];
    for (const n of [0, -1, -5]) {
      const pred = withinLastN(n, toolCalled('bash'));
      assert.strictEqual(
        await pred(
          wctx({ turn: 5, content: '', lastAssistantMessages: history }),
        ),
        false,
        `n=${n}`,
      );
    }
  });

  it('only rebinds lastAssistantMessage — content stays frozen', async () => {
    const history: UIMessage[] = [
      assistantTextOnly('historical error mention'),
      assistantTextOnly('historical fail mention'),
    ];
    const pred = withinLastN(3, contentIncludes(['error']));
    assert.strictEqual(
      await pred(
        wctx({
          turn: 5,
          content: 'no match here',
          lastAssistantMessages: history,
        }),
      ),
      false,
    );
  });
});

describe('everyOfLastN', () => {
  it('fires only when EVERY one of last N matches (true streak)', async () => {
    const streak: UIMessage[] = [
      assistantWithTool('bash'),
      assistantTextOnly('a'),
      assistantTextOnly('b'),
      assistantTextOnly('c'),
    ];
    const pred = everyOfLastN(3, not(anyToolCalled()));
    assert.strictEqual(
      await pred(wctx({ turn: 5, content: '', lastAssistantMessages: streak })),
      true,
    );
  });

  it('does NOT fire when one of last N breaks the streak', async () => {
    const broken: UIMessage[] = [
      assistantTextOnly('a'),
      assistantWithTool('bash'),
      assistantTextOnly('b'),
      assistantTextOnly('c'),
    ];
    const pred = everyOfLastN(3, not(anyToolCalled()));
    assert.strictEqual(
      await pred(wctx({ turn: 5, content: '', lastAssistantMessages: broken })),
      false,
    );
  });

  it('returns false when fewer than N assistant messages exist', async () => {
    const tooShort: UIMessage[] = [
      assistantTextOnly('a'),
      assistantTextOnly('b'),
    ];
    const pred = everyOfLastN(3, not(anyToolCalled()));
    assert.strictEqual(
      await pred(
        wctx({ turn: 5, content: '', lastAssistantMessages: tooShort }),
      ),
      false,
    );
    assert.strictEqual(
      await pred(wctx({ turn: 1, content: '', lastAssistantMessages: [] })),
      false,
    );
    assert.strictEqual(await pred(wctx({ turn: 1, content: '' })), false);
  });

  it('returns false when n <= 0 even with full history', async () => {
    const history: UIMessage[] = [
      assistantTextOnly('a'),
      assistantTextOnly('b'),
      assistantTextOnly('c'),
    ];
    for (const n of [0, -1, -5]) {
      const pred = everyOfLastN(n, not(anyToolCalled()));
      assert.strictEqual(
        await pred(
          wctx({ turn: 5, content: '', lastAssistantMessages: history }),
        ),
        false,
        `n=${n}`,
      );
    }
  });
});
