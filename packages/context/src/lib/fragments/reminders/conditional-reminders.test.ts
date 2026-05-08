import { type ToolUIPart, type UIMessage, isStaticToolUIPart } from 'ai';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  type MessageData,
  type MessageFragment,
  XmlRenderer,
  afterTurn,
  and,
  assistant,
  assistantText,
  contentIncludes,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  dayChanged,
  everyNTurns,
  hint,
  hourChanged,
  isConditionalReminder,
  isFragment,
  once,
  reminder,
  stripReminders,
  user,
  workflow,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

async function createVirtualAgentSandbox() {
  return createBashTool({
    sandbox: await createRoutingSandbox({
      backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
      hostExtensions: [],
    }),
  });
}

type TestToolName = 'bash' | 'sql';
type TestToolType = 'tool-bash' | 'tool-sql';
type TestToolState =
  | 'output-available'
  | 'output-error'
  | 'input-available'
  | 'input-streaming';
type OutputAvailableToolPart = ToolUIPart & {
  state: 'output-available';
  output: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUIMessage(value: unknown): value is UIMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'system' ||
      value.role === 'user' ||
      value.role === 'assistant') &&
    Array.isArray(value.parts)
  );
}

function requireUIMessage(value: unknown, label: string): UIMessage {
  assert.ok(isUIMessage(value), `${label} should be a UIMessage`);
  return value;
}

function findMessage(messages: MessageData[], name: string): MessageData {
  const message = messages.find((item) => item.name === name);
  assert.ok(message, `Expected stored ${name} message`);
  return message;
}

function isOutputAvailableToolPart(
  part: UIMessage['parts'][number],
): part is OutputAvailableToolPart {
  return isStaticToolUIPart(part) && part.state === 'output-available';
}

function getStoredMessageText(message: MessageData): string {
  return getTextParts(requireUIMessage(message.data, message.id)).join('');
}

function requireFragmentId(fragment: ContextFragment): string {
  assert.ok(fragment.id, 'Expected fragment to have an id');
  return fragment.id;
}

function toolPart(init: {
  name: TestToolName;
  state: TestToolState;
  output?: unknown;
  errorText?: string;
}): ToolUIPart {
  const type: TestToolType = init.name === 'bash' ? 'tool-bash' : 'tool-sql';
  const base: {
    type: TestToolType;
    toolCallId: string;
    input: Record<string, never>;
  } = {
    type,
    toolCallId: `${init.name}-call`,
    input: {},
  };

  switch (init.state) {
    case 'output-available':
      return {
        ...base,
        state: 'output-available',
        output: init.output,
      };
    case 'output-error':
      return {
        ...base,
        state: 'output-error',
        errorText: init.errorText ?? 'failed',
      };
    case 'input-available':
      return {
        ...base,
        state: 'input-available',
      };
    case 'input-streaming':
      return {
        ...base,
        state: 'input-streaming',
      };
    default:
      throw new Error(`Unsupported tool state: ${init.state}`);
  }
}

function assistantWithToolParts(id: string, parts: ToolUIPart[]): UIMessage {
  return {
    id,
    role: 'assistant',
    parts,
  };
}

function codecBackedAssistant(message: UIMessage): MessageFragment {
  return {
    id: message.id,
    name: 'assistant',
    type: 'message',
    persist: true,
    codec: {
      decode() {
        return structuredClone(message);
      },
      encode() {
        return structuredClone(message);
      },
    },
  };
}

function getOnlyToolPart(message: UIMessage): ToolUIPart {
  const part = message.parts.find((item): item is ToolUIPart =>
    item.type.startsWith('tool-'),
  );
  assert.ok(part, 'Expected an assistant tool part');
  return part;
}

function getToolOutput(message: UIMessage): unknown {
  const part = getOnlyToolPart(message);
  return part.state === 'output-available' ? part.output : undefined;
}

function getReminderMetadata(
  message: UIMessage,
): { reminders?: unknown[] } | undefined {
  if (!isRecord(message.metadata)) {
    return undefined;
  }

  const { reminders } = message.metadata;
  return Array.isArray(reminders) ? { reminders } : undefined;
}

async function useFakeTime<T>(
  iso: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date(iso).getTime());
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

describe('ContextEngine conditional reminders', () => {
  it('applies everyNTurns reminder on matching turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-1',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(
      reminder('every-third', { when: everyNTurns(3) }),
      user('turn 3'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('every-third'),
      `Turn 3: expected reminder to be included. Got: ${text}`,
    );
  });

  it('skips everyNTurns reminder on non-matching turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-2',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(
      reminder('every-third', { when: everyNTurns(3) }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('every-third'),
      `Turn 2: expected reminder to be skipped. Got: ${text}`,
    );
  });

  it('applies once reminder only on first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-once',
      userId: 'u1',
    });

    engine.set(reminder('welcome', { when: once() }), user('first message'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('welcome'),
      `Turn 1: expected once reminder. Got: ${text}`,
    );
  });

  it('skips once reminder after first turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-once-skip',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(reminder('welcome', { when: once() }), user('turn 2'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('welcome'),
      `Turn 2: expected once reminder to be skipped. Got: ${text}`,
    );
  });

  it('applies afterTurn reminder only after specified turn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-after',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply 1'));
    await engine.save();
    engine.set(user('turn 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(reminder('late-hint', { when: afterTurn(2) }), user('turn 3'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('late-hint'),
      `Turn 3 (afterTurn: 2): expected reminder. Got: ${text}`,
    );
  });

  it('resolves callback text with turn context', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-callback',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder((ctx) => `turn=${ctx.turn}`, { when: everyNTurns(2) }),
      user('turn 2'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('turn=2'),
      `Expected callback to receive turn=2. Got: ${text}`,
    );
  });

  it('getTurnCount counts user messages from persisted and pending', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'turn-count',
      userId: 'u1',
    });

    engine.set(user('msg 1'), assistantText('reply 1'));
    await engine.save();

    engine.set(user('msg 2'), assistantText('reply 2'));
    await engine.save();

    engine.set(user('msg 3'));

    const count = await engine.getTurnCount();
    assert.strictEqual(count, 3);
  });

  it('mixes immediate and conditional reminders', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'mixed-reminders',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();
    engine.set(user('turn 2'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('conditional', { when: everyNTurns(3) }),
      user('turn 3', reminder('always-here')),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('always-here'),
      'Immediate reminder should be present',
    );
    assert.ok(
      text.includes('conditional'),
      'Conditional reminder should be present on turn 3',
    );
  });

  it('conditional reminder text is persisted but reminder fragment is not re-evaluated by new engine', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    engine.set(reminder('baked-in', { when: everyNTurns(1) }), user('turn 1'));
    await engine.save();

    const engine2 = new ContextEngine({
      store,
      chatId: 'no-persist',
      userId: 'u1',
    });

    const { messages } = await engine2.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      text.includes('baked-in'),
      `Stored message should contain reminder text from original save. Got: ${text}`,
    );
    assert.strictEqual(
      (text.match(/baked-in/g) || []).length,
      1,
      'Reminder text should appear exactly once (not re-applied by engine2)',
    );
  });

  it('double-resolve is safe after save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'double-resolve',
      userId: 'u1',
    });

    engine.set(
      reminder('conditional', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const renderer = new XmlRenderer();
    const result1 = await engine.resolve({
      renderer,
      sandbox: await createVirtualAgentSandbox(),
    });
    const result2 = await engine.resolve({
      renderer,
      sandbox: await createVirtualAgentSandbox(),
    });

    const text1 = getTextParts(result1.messages[0]).join('');
    const text2 = getTextParts(result2.messages[0]).join('');

    const count1 = (text1.match(/conditional/g) || []).length;
    const count2 = (text2.match(/conditional/g) || []).length;

    assert.strictEqual(count1, 1, 'First resolve should have 1 reminder');
    assert.strictEqual(
      count2,
      1,
      'Second resolve should still have 1 reminder (not doubled)',
    );
  });

  it('applies multiple conditional reminders in a single save', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'multi-cond',
      userId: 'u1',
    });

    engine.set(
      reminder('r1', { when: everyNTurns(1) }),
      reminder('r2', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[0]).join('');

    assert.ok(text.includes('r1'), `Expected r1 in message. Got: ${text}`);
    assert.ok(text.includes('r2'), `Expected r2 in message. Got: ${text}`);
  });

  it('applies asPart conditional reminder as a separate text part', async () => {
    const partMode = true;
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-aspart',
      userId: 'u1',
    });

    engine.set(
      reminder('part-hint', { when: everyNTurns(1), asPart: partMode }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const parts = getTextParts(messages[0]);

    assert.strictEqual(parts.length, 2, 'Expected 2 text parts');
    assert.strictEqual(parts[0], 'hello');
    assert.strictEqual(parts[1], 'part-hint');
  });

  it('skips conditional reminder when callback returns empty string', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-empty-cb',
      userId: 'u1',
    });

    engine.set(
      reminder(() => '', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[0]).join('');

    assert.strictEqual(text, 'hello');
  });

  it('save() persists conditional reminder text and metadata to the stored message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'save-persist',
      userId: 'u1',
    });

    engine.set(
      reminder('persisted-hint', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const storedMessages = await store.getMessages('save-persist');
    const storedUser = findMessage(storedMessages, 'user');
    const storedData = requireUIMessage(storedUser.data, storedUser.id);

    const text = getTextParts(storedData).join('');
    assert.ok(
      text.includes('persisted-hint'),
      `Stored message should contain reminder text after save(). Got: ${text}`,
    );

    assert.ok(
      Array.isArray(getReminderMetadata(storedData)?.reminders),
      'Stored message should have reminder metadata',
    );
  });

  it('save then resolve does not double-apply reminders', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'save-then-resolve',
      userId: 'u1',
    });

    engine.set(reminder('once-only', { when: everyNTurns(1) }), user('hello'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const userMsg = messages.find((m) => m.role === 'user');
    assert.ok(userMsg, 'Expected resolved user message');
    const text = getTextParts(userMsg).join('');

    assert.strictEqual(
      (text.match(/once-only/g) || []).length,
      1,
      `Reminder should appear exactly once after save+resolve. Got: ${text}`,
    );
  });

  it('does not crash when no user messages exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-no-user',
      userId: 'u1',
    });

    engine.set(
      reminder('hint', { when: everyNTurns(1) }),
      assistantText('no user here'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'assistant');
  });

  it('conditional reminders do not leak into system prompt', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-no-leak',
      userId: 'u1',
    });

    engine.set(
      reminder('secret-hint', { when: everyNTurns(1) }),
      user('hello'),
    );
    await engine.save();

    const { systemPrompt } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    assert.ok(
      !systemPrompt.includes('secret-hint'),
      `System prompt should not contain conditional reminder. Got: ${systemPrompt}`,
    );
  });

  it('explicit target:user applies reminder to the pending user message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-user-explicit',
      userId: 'u1',
    });

    engine.set(
      reminder('user-targeted', { when: everyNTurns(1), target: 'user' }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[0]).join('');

    assert.ok(
      text.includes('user-targeted'),
      `Explicit user target should preserve user reminder behavior. Got: ${text}`,
    );
  });

  it('target:tool-output appends reminder to a single string output-available tool output', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-string',
      userId: 'u1',
    });

    engine.set(user('run bash'));
    await engine.save();

    engine.set(
      reminder('inspect stdout before answering', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      assistant(
        assistantWithToolParts('assistant-string-tool', [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-string'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(
      part.state,
      'output-available',
      'Tool state should remain completed',
    );
    assert.strictEqual(
      part.output,
      'stdout<system-reminder>inspect stdout before answering</system-reminder>',
    );
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders?.length,
      1,
    );
  });

  it('target:tool-output persists reminders for codec-backed assistant fragments', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-codec-backed',
      userId: 'u1',
    });

    engine.set(user('run bash'));
    await engine.save();

    engine.set(
      reminder('inspect cloned stdout before answering', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      codecBackedAssistant(
        assistantWithToolParts('assistant-codec-backed-tool', [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-codec-backed'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(
      part.state === 'output-available' ? part.output : undefined,
      'stdout<system-reminder>inspect cloned stdout before answering</system-reminder>',
    );
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders?.length,
      1,
    );
  });

  it('target:tool-output preserves branch IDs when updating an existing assistant', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-branch-id',
      userId: 'u1',
    });

    const originalAssistantId = 'assistant-branch-tool';
    engine.set(
      user('run bash'),
      assistant(
        assistantWithToolParts(originalAssistantId, [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    engine.set(
      reminder('inspect branched stdout before answering', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      codecBackedAssistant(
        assistantWithToolParts(originalAssistantId, [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'updated stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    const activeMessages = await store.getMessages(
      'cond-target-tool-branch-id',
    );
    const branchedAssistant = activeMessages.find((message) => {
      if (message.name !== 'assistant') return false;
      const storedMessage = requireUIMessage(message.data, message.id);
      const output = getToolOutput(storedMessage);
      return typeof output === 'string' && output.includes('updated stdout');
    });

    assert.ok(
      branchedAssistant,
      'Updated assistant message should exist on the new branch',
    );
    assert.notStrictEqual(
      branchedAssistant.id,
      originalAssistantId,
      'Branched assistant should get a new graph message id',
    );

    const branchedMessage = requireUIMessage(
      branchedAssistant.data,
      branchedAssistant.id,
    );
    assert.strictEqual(
      branchedMessage.id,
      branchedAssistant.id,
      'Branched stored assistant message should keep UIMessage.id aligned with the graph message id',
    );
    assert.strictEqual(
      getToolOutput(branchedMessage),
      'updated stdout<system-reminder>inspect branched stdout before answering</system-reminder>',
    );

    const originalAssistant = await store.getMessage(originalAssistantId);
    assert.ok(
      originalAssistant,
      'Original assistant message should still exist on the old branch',
    );
    const originalMessage = requireUIMessage(
      originalAssistant.data,
      originalAssistant.id,
    );
    assert.strictEqual(getToolOutput(originalMessage), 'stdout');
  });

  it('target:tool-output wraps a single non-string output-available tool output', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-object',
      userId: 'u1',
    });

    engine.set(user('query data'));
    await engine.save();

    engine.set(
      reminder('validate rows before answering', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      assistant(
        assistantWithToolParts('assistant-object-tool', [
          toolPart({
            name: 'sql',
            state: 'output-available',
            output: { rows: [{ id: 1 }] },
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-object'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(part.state, 'output-available');
    assert.deepStrictEqual(part.output, {
      result: { rows: [{ id: 1 }] },
      systemReminder: 'validate rows before answering',
    });
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders?.length,
      1,
    );
  });

  it('target:tool-output no-ops when there is no eligible output-available tool output', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-none',
      userId: 'u1',
    });

    engine.set(user('call a tool'));
    await engine.save();

    engine.set(
      reminder('should not appear', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      assistant(
        assistantWithToolParts('assistant-no-output-tool', [
          toolPart({ name: 'bash', state: 'input-available' }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-none'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(part.state, 'input-available');
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders,
      undefined,
    );
  });

  it('target:tool-output no-ops when multiple output-available tool outputs exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-parallel',
      userId: 'u1',
    });

    engine.set(user('run parallel tools'));
    await engine.save();

    engine.set(
      reminder('ambiguous target', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      assistant(
        assistantWithToolParts('assistant-parallel-tool', [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'one',
          }),
          toolPart({
            name: 'sql',
            state: 'output-available',
            output: 'two',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-parallel'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const outputs = assistantMessage.parts
      .filter((part): part is ToolUIPart => part.type.startsWith('tool-'))
      .map((part) => (part.state === 'output-available' ? part.output : null));

    assert.deepStrictEqual(outputs, ['one', 'two']);
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders,
      undefined,
    );
  });

  it('target:tool-output ignores asPart', async () => {
    const partMode = true;
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-ignore-aspart',
      userId: 'u1',
    });

    engine.set(user('run bash'));
    await engine.save();

    engine.set(
      reminder('stay on output', {
        when: everyNTurns(1),
        target: 'tool-output',
        asPart: partMode,
      }),
      assistant(
        assistantWithToolParts('assistant-ignore-aspart-tool', [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-ignore-aspart'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(assistantMessage.parts.length, 1);
    assert.strictEqual(
      part.state === 'output-available' ? part.output : undefined,
      'stdout<system-reminder>stay on output</system-reminder>',
    );
  });

  it('target:tool-output does not apply to output-error tool parts', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-error',
      userId: 'u1',
    });

    engine.set(user('run bash'));
    await engine.save();

    engine.set(
      reminder('should not apply to errors', {
        when: everyNTurns(1),
        target: 'tool-output',
      }),
      assistant(
        assistantWithToolParts('assistant-error-tool', [
          toolPart({
            name: 'bash',
            state: 'output-error',
            errorText: 'boom',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-error'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(part.state, 'output-error');
    assert.strictEqual(
      part.state === 'output-error' ? part.errorText : undefined,
      'boom',
    );
    assert.strictEqual(
      getReminderMetadata(assistantMessage)?.reminders,
      undefined,
    );
  });

  it('target:tool-output sees pending user message in same turn (no user-target reminders configured)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-tool-pending-user',
      userId: 'u1',
    });

    engine.set(
      reminder('check this', {
        when: contentIncludes(['flag']),
        target: 'tool-output',
      }),
      user('flag is set'),
      assistant(
        assistantWithToolParts('a-pending-user', [
          toolPart({
            name: 'bash',
            state: 'output-available',
            output: 'stdout',
          }),
        ]),
      ),
    );
    await engine.save();

    const storedAssistant = findMessage(
      await store.getMessages('cond-target-tool-pending-user'),
      'assistant',
    );
    const assistantMessage = requireUIMessage(
      storedAssistant.data,
      storedAssistant.id,
    );
    const part = getOnlyToolPart(assistantMessage);

    assert.strictEqual(
      part.state === 'output-available' ? part.output : undefined,
      'stdout<system-reminder>check this</system-reminder>',
      'tool-output predicate must see pending user message even when no user-target reminders are configured',
    );
  });

  it('applies reminder regardless of set() order (reminder after user)', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-order',
      userId: 'u1',
    });

    engine.set(user('hello'), reminder('after-user', { when: everyNTurns(1) }));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[0]).join('');

    assert.ok(
      text.includes('after-user'),
      `Reminder should apply even when set after user. Got: ${text}`,
    );
  });

  it('targets last user message when both persisted and pending exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-target-last',
      userId: 'u1',
    });

    engine.set(user('persisted-msg'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('targeted', { when: everyNTurns(1) }),
      user('pending-msg'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });

    const persistedUser = messages.find(
      (m) =>
        m.role === 'user' &&
        getTextParts(m).some((t) => t.includes('persisted-msg')),
    );
    const pendingUser = messages.find(
      (m) =>
        m.role === 'user' &&
        getTextParts(m).some((t) => t.includes('pending-msg')),
    );
    assert.ok(persistedUser, 'Expected persisted user message');
    assert.ok(pendingUser, 'Expected pending user message');

    const persistedText = getTextParts(persistedUser).join('');
    const pendingText = getTextParts(pendingUser).join('');

    assert.ok(
      !persistedText.includes('targeted'),
      `Persisted user message should NOT have reminder. Got: ${persistedText}`,
    );
    assert.ok(
      pendingText.includes('targeted'),
      `Pending (last) user message should have reminder. Got: ${pendingText}`,
    );
  });

  it('stripReminders works on conditionally-applied reminders', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cond-strip',
      userId: 'u1',
    });

    engine.set(reminder('strippable', { when: everyNTurns(1) }), user('hello'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const userMsg = messages[0];
    const textBefore = getTextParts(userMsg).join('');
    assert.ok(textBefore.includes('strippable'));

    const stripped = stripReminders(userMsg);
    const textAfter = getTextParts(stripped).join('');

    assert.strictEqual(textAfter, 'hello');
    assert.ok(
      !textAfter.includes('strippable'),
      `Stripped message should not contain reminder. Got: ${textAfter}`,
    );
  });

  it('preserves branching-assigned ID when conditional reminders re-create the fragment', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'branch-cond',
      userId: 'u1',
    });

    engine.set(user('warmup'), assistantText('ack'));
    await engine.save();

    const original = user('hello');
    const originalId = requireFragmentId(original);
    engine.set(original, assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('branch-hint', { when: everyNTurns(1) }),
      user({
        id: originalId,
        role: 'user',
        parts: [{ type: 'text', text: 'updated' }],
      }),
    );
    await engine.save();

    const activeBranchMessages = await store.getMessages('branch-cond');
    const branchedUser = activeBranchMessages.find(
      (m) => m.name === 'user' && getStoredMessageText(m).includes('updated'),
    );

    assert.ok(
      branchedUser,
      'Updated user message should exist on the new branch',
    );
    assert.notStrictEqual(
      branchedUser.id,
      originalId,
      'Branched message should have a new ID, not the original',
    );
    assert.ok(
      getStoredMessageText(branchedUser).includes('branch-hint'),
      'Conditional reminder should be applied to the branched message',
    );
    assert.strictEqual(
      requireUIMessage(branchedUser.data, branchedUser.id).id,
      branchedUser.id,
      'Branched stored user message should keep UIMessage.id aligned with the graph message id',
    );

    const originalMsg = await store.getMessage(originalId);
    assert.ok(originalMsg, 'Original message should still exist on old branch');
    const originalText = getStoredMessageText(originalMsg);
    assert.ok(
      !originalText.includes('branch-hint'),
      `Original message should be untouched. Got: ${originalText}`,
    );
  });

  it('applies async when predicate that resolves to true', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'async-when-true',
      userId: 'u1',
    });

    engine.set(
      reminder('async-fired', {
        when: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return true;
        },
      }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[messages.length - 1]).join('');
    assert.ok(
      text.includes('async-fired'),
      `Async predicate returning true should inject reminder. Got: ${text}`,
    );
  });

  it('skips async when predicate that resolves to false', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'async-when-false',
      userId: 'u1',
    });

    engine.set(
      reminder('async-skipped', {
        when: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return false;
        },
      }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[messages.length - 1]).join('');
    assert.ok(
      !text.includes('async-skipped'),
      `Async predicate returning false should skip reminder. Got: ${text}`,
    );
  });

  it('resolves async ReminderText callback', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'async-text',
      userId: 'u1',
    });

    engine.set(
      reminder(
        async () => {
          await new Promise((r) => setTimeout(r, 1));
          return 'fetched-from-api';
        },
        { when: once() },
      ),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[messages.length - 1]).join('');
    assert.ok(
      text.includes('fetched-from-api'),
      `Async text callback should resolve and inject. Got: ${text}`,
    );
  });

  it('composes async predicate with sync predicate via and()', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'async-and-sync',
      userId: 'u1',
    });

    const asyncAlwaysTrue = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return true;
    };

    engine.set(
      reminder('mixed-combo', {
        when: and(once(), asyncAlwaysTrue),
      }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const text = getTextParts(messages[messages.length - 1]).join('');
    assert.ok(
      text.includes('mixed-combo'),
      `and(sync, async) should fire when both true. Got: ${text}`,
    );
  });

  it('applies dayChanged temporal predicate when day crosses between turns', async () => {
    await useFakeTime('2026-03-27T23:00:00Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temporal-day',
        userId: 'u1',
      });

      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-28T01:00:00Z').getTime());

      engine.set(reminder('new-day', { when: dayChanged() }), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const lastMsg = messages[messages.length - 1];
      const text = getTextParts(lastMsg).join('');

      assert.ok(
        text.includes('new-day'),
        `Day changed reminder should fire. Got: ${text}`,
      );
    });
  });

  it('skips dayChanged temporal predicate when still the same day', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'temporal-day-skip',
      userId: 'u1',
    });

    engine.set(user('turn 1'), assistantText('reply'));
    await engine.save();

    engine.set(reminder('same-day', { when: dayChanged() }), user('turn 2'));
    await engine.save();

    const { messages } = await engine.resolve({
      renderer: new XmlRenderer(),
      sandbox: await createVirtualAgentSandbox(),
    });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');

    assert.ok(
      !text.includes('same-day'),
      `Same-day reminder should be skipped. Got: ${text}`,
    );
  });

  it('composes dayChanged with afterTurn in engine context', async () => {
    await useFakeTime('2026-03-27T23:00:00Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temporal-compose',
        userId: 'u1',
      });

      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-28T01:00:00Z').getTime());

      engine.set(
        reminder('composed', { when: and(dayChanged(), afterTurn(2)) }),
        user('turn 2'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const lastMsg = messages[messages.length - 1];
      const text = getTextParts(lastMsg).join('');

      assert.ok(
        !text.includes('composed'),
        `Turn 2 with afterTurn(2) should not fire. Got: ${text}`,
      );
    });
  });

  it('applies hourChanged temporal predicate when hour crosses', async () => {
    await useFakeTime('2026-03-27T14:55:00Z', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'temporal-hour',
        userId: 'u1',
      });

      engine.set(user('turn 1'), assistantText('reply'));
      await engine.save();

      mock.timers.setTime(new Date('2026-03-27T15:05:00Z').getTime());

      engine.set(reminder('new-hour', { when: hourChanged() }), user('turn 2'));
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const lastMsg = messages[messages.length - 1];
      const text = getTextParts(lastMsg).join('');

      assert.ok(
        text.includes('new-hour'),
        `Hour changed reminder should fire. Got: ${text}`,
      );
    });
  });

  describe('fragment-based reminders', () => {
    it('applies a conditional workflow fragment reminder when predicate fires', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-cond-workflow',
        userId: 'u1',
      });

      engine.set(
        reminder(
          workflow({
            task: 'Error recovery',
            steps: ['Check error logs', 'Fix the query'],
          }),
          { when: everyNTurns(1) },
        ),
        user('my query failed'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const parts = getTextParts(messages[0]);

      assert.ok(
        parts.some((p) => p.includes('<workflow>')),
        `Expected rendered workflow XML in message parts. Got: ${parts.join('|')}`,
      );
      assert.ok(
        parts.some((p) => p.includes('Error recovery')),
        `Expected workflow task in message. Got: ${parts.join('|')}`,
      );
    });

    it('skips conditional fragment reminder when predicate returns false', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-cond-skip',
        userId: 'u1',
      });

      engine.set(
        reminder(
          workflow({
            task: 'Error recovery',
            steps: ['Check logs'],
          }),
          { when: () => false },
        ),
        user('hello'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const text = getTextParts(messages[0]).join('');

      assert.ok(
        !text.includes('<workflow>'),
        `Expected no workflow in message. Got: ${text}`,
      );
      assert.strictEqual(text, 'hello');
    });

    it('defaults to asPart: false for fragment reminders', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-aspart-default',
        userId: 'u1',
      });

      engine.set(
        reminder(hint('Check indexes'), { when: everyNTurns(1) }),
        user('slow query'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const parts = getTextParts(messages[0]);

      assert.strictEqual(
        parts.length,
        1,
        'Fragment reminder should default inline',
      );
      assert.ok(
        parts[0].includes('slow query'),
        `Inline part should contain user text. Got: ${parts[0]}`,
      );
      assert.ok(
        parts[0].includes('Check indexes'),
        `Inline part should contain hint. Got: ${parts[0]}`,
      );
    });

    it('respects explicit asPart: false override on fragment reminders', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-aspart-override',
        userId: 'u1',
      });

      engine.set(
        reminder(hint('inline hint'), { when: everyNTurns(1), asPart: false }),
        user('hello'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const parts = getTextParts(messages[0]);

      assert.strictEqual(
        parts.length,
        1,
        'With asPart: false, reminder should be inline',
      );
      assert.ok(
        parts[0].includes('inline hint'),
        `Inline part should contain hint. Got: ${parts[0]}`,
      );
    });

    it('applies immediate fragment reminder inside user()', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-immediate',
        userId: 'u1',
      });

      engine.set(
        user(
          'hello',
          reminder(
            workflow({
              task: 'Greet user',
              steps: ['Say hi', 'Ask how they are'],
            }),
          ),
        ),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const parts = getTextParts(messages[0]);

      assert.ok(
        parts.some((p) => p.includes('Greet user')),
        `Expected workflow in message. Got: ${parts.join('|')}`,
      );
    });

    it('composes fragment reminder with contentIncludes predicate', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-content-match',
        userId: 'u1',
      });

      engine.set(
        reminder(
          workflow({
            task: 'SQL error recovery',
            steps: ['Read error message', 'Check schema', 'Fix query'],
          }),
          { when: contentIncludes(['error', 'fail']) },
        ),
        user('my query has an error'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const text = getTextParts(messages[0]).join('');

      assert.ok(
        text.includes('SQL error recovery'),
        `Content-matching reminder should fire. Got: ${text}`,
      );
    });

    it('does not fire fragment reminder when content does not match', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-content-miss',
        userId: 'u1',
      });

      engine.set(
        reminder(
          workflow({
            task: 'SQL error recovery',
            steps: ['Read error message'],
          }),
          { when: contentIncludes(['error', 'fail']) },
        ),
        user('show me all users'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const text = getTextParts(messages[0]).join('');

      assert.ok(
        !text.includes('SQL error recovery'),
        `Reminder should not fire for non-matching content. Got: ${text}`,
      );
    });

    it('stripReminders works on fragment-based reminders', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-strip',
        userId: 'u1',
      });

      engine.set(
        reminder(workflow({ task: 'Strippable', steps: ['step1'] }), {
          when: everyNTurns(1),
        }),
        user('hello'),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const userMsg = messages[0];
      const textBefore = getTextParts(userMsg).join('');
      assert.ok(textBefore.includes('Strippable'));

      const stripped = stripReminders(userMsg);
      const textAfter = getTextParts(stripped).join('');
      assert.strictEqual(textAfter, 'hello');
    });

    it('conditional fragment reminder satisfies isFragment and isConditionalReminder', () => {
      const frag = reminder(workflow({ task: 'Test', steps: ['s1'] }), {
        when: everyNTurns(1),
      });

      assert.ok(
        isFragment(frag),
        'Conditional fragment reminder should satisfy isFragment()',
      );
      assert.ok(
        isConditionalReminder(frag),
        'Conditional fragment reminder should satisfy isConditionalReminder()',
      );
    });

    it('stripReminders works on immediate fragment reminders inside user()', async () => {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: 'frag-imm-strip',
        userId: 'u1',
      });

      engine.set(
        user('hello', reminder(workflow({ task: 'Immediate', steps: ['s1'] }))),
      );
      await engine.save();

      const { messages } = await engine.resolve({
        renderer: new XmlRenderer(),
        sandbox: await createVirtualAgentSandbox(),
      });
      const userMsg = messages[0];
      const textBefore = getTextParts(userMsg).join('');
      assert.ok(textBefore.includes('Immediate'));

      const stripped = stripReminders(userMsg);
      const textAfter = getTextParts(stripped).join('');
      assert.strictEqual(textAfter, 'hello');
    });

    it('throws on empty fragment for immediate reminder', () => {
      const emptyFragment: ContextFragment = { name: 'empty', data: null };
      assert.throws(
        () => reminder(emptyFragment),
        /Reminder text must not be empty/,
      );
    });

    it('throws on empty fragment for conditional reminder', () => {
      const emptyFragment: ContextFragment = { name: 'empty', data: null };
      assert.throws(
        () => reminder(emptyFragment, { when: everyNTurns(1) }),
        /Reminder text must not be empty/,
      );
    });
  });
});
