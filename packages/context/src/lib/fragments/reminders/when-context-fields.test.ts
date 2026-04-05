import type { LanguageModelUsage, UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  type ReminderContext,
  type WhenContext,
  XmlRenderer,
  assistantText,
  reminder,
  user,
} from '@deepagents/context';

import { getTextParts } from '../../text.ts';

describe('WhenContext: chat', () => {
  it('exposes chat metadata set via engine constructor', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'meta-test',
      userId: 'u1',
      metadata: { plan: 'enterprise', environment: 'staging' },
    });

    engine.set(
      reminder('enterprise-hint', {
        when: (ctx: WhenContext) => ctx.chat.metadata?.plan === 'enterprise',
      }),
      user('hello'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('enterprise-hint'),
      `Expected metadata match. Got: ${text}`,
    );
  });

  it('returns undefined metadata when none set', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-meta',
      userId: 'u1',
    });

    let captured: Record<string, unknown> | undefined = 'NOT_SET' as any;
    engine.set(
      reminder('check', {
        when: (ctx: WhenContext) => {
          captured = ctx.chat.metadata;
          return false;
        },
      }),
      user('hello'),
    );
    await engine.save();

    assert.strictEqual(captured, undefined);
  });
});

describe('WhenContext: usage', () => {
  it('exposes token usage after trackUsage()', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'usage-test',
      userId: 'u1',
    });

    engine.set(user('first message'), assistantText('response'));
    await engine.save();

    await engine.trackUsage({
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
    } as LanguageModelUsage);

    engine.set(
      reminder('budget-warning', {
        when: (ctx: WhenContext) => (ctx.usage?.totalTokens ?? 0) > 100,
      }),
      user('second message'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');
    assert.ok(
      text.includes('budget-warning'),
      `Expected usage match. Got: ${text}`,
    );
  });
});

describe('WhenContext: branch', () => {
  it('exposes "main" branch by default', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'branch-test',
      userId: 'u1',
    });

    let capturedBranch = '';
    engine.set(
      reminder('main-hint', {
        when: (ctx: WhenContext) => {
          capturedBranch = ctx.branch;
          return ctx.branch === 'main';
        },
      }),
      user('hello'),
    );
    await engine.save();

    assert.strictEqual(capturedBranch, 'main');
    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('main-hint'),
      `Expected branch match. Got: ${text}`,
    );
  });

  it('reflects branch name after rewind', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'branch-rewind',
      userId: 'u1',
    });

    engine.set(user('first'));
    await engine.save();

    const headId = engine.headMessageId!;
    engine.set(assistantText('reply'));
    await engine.save();

    await engine.rewind(headId);

    let capturedBranch = '';
    engine.set(
      reminder('branched-hint', {
        when: (ctx: WhenContext) => {
          capturedBranch = ctx.branch;
          return ctx.branch !== 'main';
        },
      }),
      user('on new branch'),
    );
    await engine.save();

    assert.ok(
      capturedBranch.startsWith('main-v'),
      `Expected branched name. Got: ${capturedBranch}`,
    );
  });
});

describe('WhenContext: chat.userId and chat.id', () => {
  it('exposes userId and chatId via chat object', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'chat-42',
      userId: 'user-7',
    });

    let capturedUserId = '';
    let capturedChatId = '';
    engine.set(
      reminder('id-hint', {
        when: (ctx: WhenContext) => {
          capturedUserId = ctx.chat.userId;
          capturedChatId = ctx.chat.id;
          return true;
        },
      }),
      user('hello'),
    );
    await engine.save();

    assert.strictEqual(capturedUserId, 'user-7');
    assert.strictEqual(capturedChatId, 'chat-42');
  });
});

describe('WhenContext: messageCount', () => {
  it('counts all messages including assistant', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'msgcount-test',
      userId: 'u1',
    });

    engine.set(user('msg1'), assistantText('reply1'));
    await engine.save();

    engine.set(user('msg2'), assistantText('reply2'));
    await engine.save();

    let capturedCount = 0;
    engine.set(
      reminder('count-hint', {
        when: (ctx: WhenContext) => {
          capturedCount = ctx.messageCount;
          return ctx.messageCount >= 5;
        },
      }),
      user('msg3'),
    );
    await engine.save();

    assert.strictEqual(capturedCount, 5);
  });
});

describe('WhenContext: content.length', () => {
  it('exposes content length of current message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'contentlen-test',
      userId: 'u1',
    });

    engine.set(
      reminder('long-msg-hint', {
        when: (ctx: WhenContext) => ctx.content.length > 20,
      }),
      user('this is a longer message for testing'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('long-msg-hint'),
      `Expected contentLength match. Got: ${text}`,
    );
  });

  it('skips for short messages', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'contentlen-skip',
      userId: 'u1',
    });

    engine.set(
      reminder('nope', {
        when: (ctx: WhenContext) => ctx.content.length > 100,
      }),
      user('hi'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(!text.includes('nope'), `Expected skip. Got: ${text}`);
  });
});

describe('WhenContext: lastAssistantMessage', () => {
  it('exposes the last assistant message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'lastasst-test',
      userId: 'u1',
    });

    engine.set(user('hello'), assistantText('I encountered an error'));
    await engine.save();

    engine.set(
      reminder('debug-hint', {
        when: (ctx: WhenContext) => {
          if (!ctx.lastAssistantMessage) return false;
          return getTextParts(ctx.lastAssistantMessage)
            .join('')
            .includes('error');
        },
      }),
      user('what happened?'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');
    assert.ok(
      text.includes('debug-hint'),
      `Expected lastAssistantMessage match. Got: ${text}`,
    );
  });

  it('is undefined when no assistant messages exist', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'no-asst',
      userId: 'u1',
    });

    let captured: UIMessage | undefined = 'NOT_SET' as any;
    engine.set(
      reminder('check', {
        when: (ctx: WhenContext) => {
          captured = ctx.lastAssistantMessage;
          return false;
        },
      }),
      user('first message'),
    );
    await engine.save();

    assert.strictEqual(captured, undefined);
  });
});

describe('WhenContext: elapsed', () => {
  it('is undefined on first message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'elapsed-first',
      userId: 'u1',
    });

    let capturedElapsed: number | undefined = -1;
    engine.set(
      reminder('check', {
        when: (ctx: WhenContext) => {
          capturedElapsed = ctx.elapsed;
          return false;
        },
      }),
      user('hello'),
    );
    await engine.save();

    assert.strictEqual(capturedElapsed, undefined);
  });

  it('is a positive number after first message', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'elapsed-second',
      userId: 'u1',
    });

    engine.set(user('first'), assistantText('reply'));
    await engine.save();

    let capturedElapsed: number | undefined;
    engine.set(
      reminder('check', {
        when: (ctx: WhenContext) => {
          capturedElapsed = ctx.elapsed;
          return false;
        },
      }),
      user('second'),
    );
    await engine.save();

    assert.strictEqual(typeof capturedElapsed, 'number');
    assert.ok(
      capturedElapsed! >= 0,
      `Expected non-negative elapsed. Got: ${capturedElapsed}`,
    );
  });
});

describe('WhenContext: chat.createdAt', () => {
  it('exposes chat creation timestamp', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'created-test',
      userId: 'u1',
    });

    let capturedCreatedAt = 0;
    engine.set(
      reminder('check', {
        when: (ctx: WhenContext) => {
          capturedCreatedAt = ctx.chat.createdAt;
          return false;
        },
      }),
      user('hello'),
    );
    await engine.save();

    assert.strictEqual(typeof capturedCreatedAt, 'number');
    assert.ok(
      capturedCreatedAt > 0,
      `Expected positive chat.createdAt. Got: ${capturedCreatedAt}`,
    );
    assert.ok(
      capturedCreatedAt <= Date.now(),
      `Expected chat.createdAt <= now. Got: ${capturedCreatedAt}`,
    );
  });
});

describe('ReminderContext symmetry', () => {
  it('reminder text callback receives expanded fields', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'ctx-symmetry',
      userId: 'u1',
      metadata: { tier: 'pro' },
    });

    engine.set(user('setup'), assistantText('done'));
    await engine.save();

    let capturedCtx: ReminderContext | undefined;
    engine.set(
      reminder(
        (ctx: ReminderContext) => {
          capturedCtx = ctx;
          return `tier:${ctx.chat?.metadata?.tier} branch:${ctx.branch}`;
        },
        {
          when: () => true,
        },
      ),
      user('check context'),
    );
    await engine.save();

    assert.ok(capturedCtx, 'ReminderContext should have been captured');
    assert.strictEqual(capturedCtx.chat?.metadata?.tier, 'pro');
    assert.strictEqual(capturedCtx.chat?.userId, 'u1');
    assert.strictEqual(capturedCtx.chat?.id, 'ctx-symmetry');
    assert.strictEqual(capturedCtx.branch, 'main');
    assert.strictEqual(typeof capturedCtx.messageCount, 'number');
    assert.strictEqual(typeof capturedCtx.chat?.createdAt, 'number');
  });
});
