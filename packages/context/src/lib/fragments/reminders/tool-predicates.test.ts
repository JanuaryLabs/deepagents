import type { ToolUIPart, UIMessage } from 'ai';
import { generateId } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  anyToolCalled,
  assistant,
  reminder,
  toolCall,
  toolCallCount,
  toolCalled,
  toolFailed,
  user,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

interface ToolPartInit {
  name: string;
  state: ToolUIPart['state'];
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function toolPart(init: ToolPartInit): ToolUIPart {
  const base = {
    type: `tool-${init.name}` as const,
    toolCallId: generateId(),
  };
  switch (init.state) {
    case 'input-streaming':
      return { ...base, state: 'input-streaming', input: init.input };
    case 'input-available':
      return { ...base, state: 'input-available', input: init.input };
    case 'output-available':
      return {
        ...base,
        state: 'output-available',
        input: init.input,
        output: init.output,
      };
    case 'output-error':
      return {
        ...base,
        state: 'output-error',
        input: init.input,
        errorText: init.errorText ?? '',
      };
    default:
      throw new Error(`unsupported state: ${init.state}`);
  }
}

function assistantWithTools(parts: ToolPartInit[], text?: string): UIMessage {
  const messageParts: UIMessage['parts'] = parts.map(toolPart);
  if (text) {
    messageParts.push({ type: 'text', text });
  }
  return {
    id: generateId(),
    role: 'assistant',
    parts: messageParts,
  };
}

async function setupTurn(
  chatId: string,
  assistantParts: ToolPartInit[] | undefined,
  assistantText?: string,
) {
  const store = new InMemoryContextStore();
  const engine = new ContextEngine({ store, chatId, userId: 'u1' });

  engine.set(user('turn 1'));
  if (assistantParts !== undefined) {
    engine.set(assistant(assistantWithTools(assistantParts, assistantText)));
  } else if (assistantText) {
    engine.set(
      assistant({
        id: generateId(),
        role: 'assistant',
        parts: [{ type: 'text', text: assistantText }],
      }),
    );
  } else {
    engine.set(assistant({ id: generateId(), role: 'assistant', parts: [] }));
  }
  await engine.save();
  return { engine, store };
}

async function lastUserText(engine: ContextEngine): Promise<string> {
  const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
  return getTextParts(messages[messages.length - 1]).join('');
}

describe('toolCalled', () => {
  it('fires when last assistant has a matching tool part in input-available', async () => {
    const { engine } = await setupTurn('tc-input-available', [
      { name: 'bash', state: 'input-available', input: { cmd: 'ls' } },
    ]);
    engine.set(
      reminder('bash-fired', { when: toolCalled('bash') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('bash-fired'));
  });

  it('fires for output-available and output-error completed states', async () => {
    for (const state of ['output-available', 'output-error'] as const) {
      const { engine } = await setupTurn(`tc-${state}`, [
        {
          name: 'bash',
          state,
          input: { cmd: 'ls' },
          output: state === 'output-available' ? { exit: 0 } : undefined,
          errorText: state === 'output-error' ? 'boom' : undefined,
        },
      ]);
      engine.set(
        reminder('bash-fired', { when: toolCalled('bash') }),
        user('turn 2'),
      );
      await engine.save();
      assert.ok(
        (await lastUserText(engine)).includes('bash-fired'),
        `state=${state}`,
      );
    }
  });

  it('does NOT fire when only an input-streaming tool part exists', async () => {
    const { engine } = await setupTurn('tc-streaming', [
      { name: 'bash', state: 'input-streaming', input: { cmd: 'ls' } },
    ]);
    engine.set(
      reminder('bash-fired', { when: toolCalled('bash') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('bash-fired'));
  });

  it('does NOT fire when only a different tool was called', async () => {
    const { engine } = await setupTurn('tc-other-tool', [
      { name: 'grep', state: 'input-available', input: { pattern: 'x' } },
    ]);
    engine.set(
      reminder('bash-fired', { when: toolCalled('bash') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('bash-fired'));
  });

  it('supports function name matcher (prefix)', async () => {
    const { engine } = await setupTurn('tc-prefix', [
      { name: 'http_get', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('http-fired', {
        when: toolCalled((n) => n.startsWith('http_')),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('http-fired'));
  });

  it('function matcher does NOT fire when no name matches', async () => {
    const { engine } = await setupTurn('tc-prefix-miss', [
      { name: 'bash', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('http-fired', {
        when: toolCalled((n) => n.startsWith('http_')),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('http-fired'));
  });

  it('returns false on first turn (no assistant history)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'tc-first',
      userId: 'u1',
    });
    engine.set(
      reminder('bash-fired', { when: toolCalled('bash') }),
      user('only message'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('bash-fired'));
  });
});

describe('toolFailed', () => {
  it('fires only on output-error', async () => {
    const { engine } = await setupTurn('tf-error', [
      {
        name: 'bash',
        state: 'output-error',
        input: {},
        errorText: 'permission denied',
      },
    ]);
    engine.set(
      reminder('failed', { when: toolFailed('bash') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('failed'));
  });

  it('does NOT fire on output-available', async () => {
    const { engine } = await setupTurn('tf-success', [
      {
        name: 'bash',
        state: 'output-available',
        input: {},
        output: { ok: true },
      },
    ]);
    engine.set(
      reminder('failed', { when: toolFailed('bash') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('failed'));
  });
});

describe('toolCall structured options', () => {
  it('matches input predicate', async () => {
    const { engine } = await setupTurn('tcs-input', [
      { name: 'bash', state: 'input-available', input: { cmd: 'rm -rf /tmp' } },
    ]);
    engine.set(
      reminder('rm-detected', {
        when: toolCall({
          name: 'bash',
          input: (i) => /rm -rf/.test((i as { cmd: string }).cmd),
        }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('rm-detected'));
  });

  it('input predicate skips streaming parts', async () => {
    const { engine } = await setupTurn('tcs-input-stream', [
      { name: 'bash', state: 'input-streaming', input: { cmd: 'rm -rf' } },
    ]);
    engine.set(
      reminder('rm-detected', {
        when: toolCall({
          name: 'bash',
          input: (i) => /rm -rf/.test((i as { cmd: string }).cmd),
        }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('rm-detected'));
  });

  it('matches output predicate only on output-available', async () => {
    const { engine } = await setupTurn('tcs-output', [
      {
        name: 'bash',
        state: 'output-available',
        input: {},
        output: 'exit code: 1',
      },
    ]);
    engine.set(
      reminder('nonzero', {
        when: toolCall({
          output: (o) => /exit code: [^0]/.test(String(o)),
        }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('nonzero'));
  });

  it('combines name + state + errorText', async () => {
    const { engine } = await setupTurn('tcs-error-text', [
      {
        name: 'bash',
        state: 'output-error',
        input: {},
        errorText: 'permission denied',
      },
    ]);
    engine.set(
      reminder('perm-error', {
        when: toolCall({
          name: 'bash',
          state: 'output-error',
          errorText: (t) => t.includes('permission denied'),
        }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('perm-error'));
  });

  it('explicit state: input-streaming matches in-flight parts', async () => {
    const { engine } = await setupTurn('tcs-streaming-explicit', [
      { name: 'bash', state: 'input-streaming', input: { partial: true } },
    ]);
    engine.set(
      reminder('streaming', {
        when: toolCall({ state: 'input-streaming' }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('streaming'));
  });
});

describe('anyToolCalled', () => {
  it('fires for any completed tool part', async () => {
    const { engine } = await setupTurn('any-completed', [
      { name: 'grep', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('any-fired', { when: anyToolCalled() }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('any-fired'));
  });

  it('does NOT fire when only streaming parts exist', async () => {
    const { engine } = await setupTurn('any-streaming', [
      { name: 'grep', state: 'input-streaming', input: {} },
    ]);
    engine.set(
      reminder('any-fired', { when: anyToolCalled() }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('any-fired'));
  });

  it('does NOT fire on text-only assistant message', async () => {
    const { engine } = await setupTurn(
      'any-text-only',
      undefined,
      'plain text reply',
    );
    engine.set(
      reminder('any-fired', { when: anyToolCalled() }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('any-fired'));
  });
});

describe('toolCallCount', () => {
  it('fires when count meets gte threshold', async () => {
    const { engine } = await setupTurn('tcc-gte', [
      { name: 'bash', state: 'input-available', input: { cmd: 'a' } },
      { name: 'bash', state: 'input-available', input: { cmd: 'b' } },
      { name: 'bash', state: 'input-available', input: { cmd: 'c' } },
    ]);
    engine.set(
      reminder('three-bashes', { when: toolCallCount('bash', { gte: 3 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('three-bashes'));
  });

  it('eq spec is strict equality', async () => {
    const { engine } = await setupTurn('tcc-eq', [
      { name: 'bash', state: 'input-available', input: {} },
      { name: 'bash', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('exactly-one', { when: toolCallCount('bash', { eq: 1 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('exactly-one'));
  });

  it('lte spec fires when count is at or below ceiling', async () => {
    const { engine } = await setupTurn('tcc-lte', [
      { name: 'bash', state: 'input-available', input: {} },
      { name: 'bash', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('at-most-2', { when: toolCallCount('bash', { lte: 2 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('at-most-2'));
  });

  it('lte spec does NOT fire when count exceeds ceiling', async () => {
    const { engine } = await setupTurn('tcc-lte-over', [
      { name: 'bash', state: 'input-available', input: {} },
      { name: 'bash', state: 'input-available', input: {} },
      { name: 'bash', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('at-most-2', { when: toolCallCount('bash', { lte: 2 }) }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('at-most-2'));
  });

  it('gte+lte range ANDs both bounds', async () => {
    const inRange = [
      { name: 'bash', state: 'input-available' as const, input: {} },
      { name: 'bash', state: 'input-available' as const, input: {} },
      { name: 'bash', state: 'input-available' as const, input: {} },
    ];
    const { engine: inEngine } = await setupTurn('tcc-range-in', inRange);
    inEngine.set(
      reminder('in-range', {
        when: toolCallCount('bash', { gte: 2, lte: 4 }),
      }),
      user('turn 2'),
    );
    await inEngine.save();
    assert.ok((await lastUserText(inEngine)).includes('in-range'));

    const outRange = [
      { name: 'bash', state: 'input-available' as const, input: {} },
    ];
    const { engine: outEngine } = await setupTurn('tcc-range-out', outRange);
    outEngine.set(
      reminder('in-range', {
        when: toolCallCount('bash', { gte: 2, lte: 4 }),
      }),
      user('turn 2'),
    );
    await outEngine.save();
    assert.ok(!(await lastUserText(outEngine)).includes('in-range'));
  });

  it('throws at builder time when spec is empty', () => {
    assert.throws(
      () => toolCallCount('bash', {}),
      /at least one of gte\/lte\/eq/,
    );
  });
});

describe('toolCalled edge cases', () => {
  it('does NOT match when name spec is the empty string and parts have non-empty names', async () => {
    const { engine } = await setupTurn('tc-empty-string', [
      { name: 'bash', state: 'input-available', input: {} },
    ]);
    engine.set(
      reminder('empty-name', { when: toolCalled('') }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok(!(await lastUserText(engine)).includes('empty-name'));
  });
});

describe('toolCall + state: input-streaming + input', () => {
  it('runs the input predicate against partial streaming input', async () => {
    const { engine } = await setupTurn('tcs-stream-input', [
      { name: 'bash', state: 'input-streaming', input: { partial: 'rm -' } },
    ]);
    engine.set(
      reminder('saw-rm', {
        when: toolCall({
          state: 'input-streaming',
          input: (i) => /rm/.test((i as { partial?: string }).partial ?? ''),
        }),
      }),
      user('turn 2'),
    );
    await engine.save();
    assert.ok((await lastUserText(engine)).includes('saw-rm'));
  });
});
