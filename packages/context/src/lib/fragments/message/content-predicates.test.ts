import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  BM25SkillClassifier,
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  afterTurn,
  and,
  assistantText,
  classifies,
  contentIncludes,
  contentMatches,
  contentPattern,
  everyNTurns,
  not,
  or,
  reminder,
  user,
} from '@deepagents/context';

function getTextParts(message: UIMessage): string[] {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);
}

describe('contentIncludes', () => {
  it('fires when message contains a keyword', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'ci-match',
      userId: 'u1',
    });

    engine.set(
      reminder('db-hint', {
        when: contentIncludes(['database', 'SQL']),
      }),
      user('I need to query the database'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(text.includes('db-hint'), `Expected reminder. Got: ${text}`);
  });

  it('is case-insensitive', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'ci-case',
      userId: 'u1',
    });

    engine.set(
      reminder('found-it', {
        when: contentIncludes(['deploy']),
      }),
      user('DEPLOY to production now'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('found-it'),
      `Expected case-insensitive match. Got: ${text}`,
    );
  });

  it('skips when no keyword matches', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'ci-skip',
      userId: 'u1',
    });

    engine.set(
      reminder('nope', {
        when: contentIncludes(['kubernetes', 'docker']),
      }),
      user('hello world'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(!text.includes('nope'), `Expected skip. Got: ${text}`);
  });

  it('matches multi-word keywords', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'ci-multi',
      userId: 'u1',
    });

    engine.set(
      reminder('dark-mode-hint', {
        when: contentIncludes(['dark mode']),
      }),
      user('can you enable dark mode please'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('dark-mode-hint'),
      `Expected multi-word match. Got: ${text}`,
    );
  });
});

describe('contentPattern', () => {
  it('fires when regex matches message content', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cp-match',
      userId: 'u1',
    });

    engine.set(
      reminder('version-hint', {
        when: contentPattern(/v\d+\.\d+\.\d+/),
      }),
      user('upgrade to v2.3.1'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('version-hint'),
      `Expected regex match. Got: ${text}`,
    );
  });

  it('skips when regex does not match', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cp-skip',
      userId: 'u1',
    });

    engine.set(
      reminder('nope', {
        when: contentPattern(/v\d+\.\d+\.\d+/),
      }),
      user('hello world'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(!text.includes('nope'), `Expected skip. Got: ${text}`);
  });

  it('supports case-insensitive flag', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cp-flag',
      userId: 'u1',
    });

    engine.set(
      reminder('error-hint', {
        when: contentPattern(/error|exception|failure/i),
      }),
      user('I got an EXCEPTION in production'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(text.includes('error-hint'), `Expected flag match. Got: ${text}`);
  });

  it('handles global flag without alternating results', () => {
    const predicate = contentPattern(/deploy/g);
    const ctx = (content: string) => ({
      turn: 1,
      content,
    });

    assert.strictEqual(predicate(ctx('deploy app')), true, 'first call');
    assert.strictEqual(
      predicate(ctx('deploy again')),
      true,
      'second call should match too',
    );
    assert.strictEqual(
      predicate(ctx('deploy service')),
      true,
      'third call should match too',
    );
  });
});

describe('contentMatches (BM25)', () => {
  it('fires when message is relevant to topics', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cm-match',
      userId: 'u1',
    });

    engine.set(
      reminder('security-hint', {
        when: contentMatches([
          'authentication and authorization',
          'security vulnerabilities',
          'password hashing',
        ]),
      }),
      user('how do I implement authentication for my API'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('security-hint'),
      `Expected BM25 match. Got: ${text}`,
    );
  });

  it('works with single-word topics but contentIncludes is preferred for keywords', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cm-single',
      userId: 'u1',
    });

    engine.set(
      reminder('sql-hint', {
        when: contentMatches(['SQL optimization', 'database indexing']),
      }),
      user('how do I optimize my SQL queries with indexing'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(text.includes('sql-hint'), `Expected topic match. Got: ${text}`);
  });

  it('skips when message is unrelated to topics', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cm-skip',
      userId: 'u1',
    });

    engine.set(
      reminder('nope', {
        when: contentMatches([
          'authentication and authorization',
          'security vulnerabilities',
        ]),
      }),
      user('xyzzyplugh zorkbleep'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(!text.includes('nope'), `Expected skip. Got: ${text}`);
  });
});

describe('classifies', () => {
  it('fires when custom classifier matches', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cl-match',
      userId: 'u1',
    });

    const skills = [
      {
        name: 'deploy',
        description: 'deployment workflows',
        path: '/s',
        skillMdPath: '/s/SKILL.md',
      },
      {
        name: 'docker',
        description: 'docker containerization',
        path: '/s',
        skillMdPath: '/s/SKILL.md',
      },
    ];
    const classifier = new BM25SkillClassifier(skills);

    engine.set(
      reminder('deploy-tip', {
        when: classifies(classifier),
      }),
      user('deploy my container to production'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('deploy-tip'),
      `Expected classifier match. Got: ${text}`,
    );
  });

  it('skips when classifier finds no match', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'cl-skip',
      userId: 'u1',
    });

    const skills = [
      {
        name: 'deploy',
        description: 'deployment workflows',
        path: '/s',
        skillMdPath: '/s/SKILL.md',
      },
    ];
    const classifier = new BM25SkillClassifier(skills);

    engine.set(
      reminder('nope', {
        when: classifies(classifier),
      }),
      user('xyzzyplugh'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(!text.includes('nope'), `Expected skip. Got: ${text}`);
  });
});

describe('composition with existing predicates', () => {
  it('composes contentIncludes with afterTurn', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-after',
      userId: 'u1',
    });

    engine.set(user('talk about database'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('db-after-turn-1', {
        when: and(afterTurn(1), contentIncludes(['database'])),
      }),
      user('more database stuff'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');
    assert.ok(
      text.includes('db-after-turn-1'),
      `Expected composed match. Got: ${text}`,
    );
  });

  it('skips when content matches but turn predicate fails', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-skip',
      userId: 'u1',
    });

    engine.set(
      reminder('too-early', {
        when: and(afterTurn(5), contentIncludes(['database'])),
      }),
      user('talk about database'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      !text.includes('too-early'),
      `Expected skip (turn 1 < 5). Got: ${text}`,
    );
  });

  it('composes contentPattern with or()', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-or',
      userId: 'u1',
    });

    engine.set(
      reminder('found-version', {
        when: or(contentPattern(/v\d+\.\d+/), contentIncludes(['upgrade'])),
      }),
      user('bump to v3.0'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('found-version'),
      `Expected or() match. Got: ${text}`,
    );
  });

  it('composes not() with contentIncludes', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-not',
      userId: 'u1',
    });

    engine.set(
      reminder('no-tests', {
        when: and(
          contentIncludes(['implement', 'build']),
          not(contentIncludes(['test'])),
        ),
      }),
      user('implement the login flow'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      text.includes('no-tests'),
      `Expected not() composition. Got: ${text}`,
    );
  });

  it('not() blocks when excluded keyword is present', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-not-block',
      userId: 'u1',
    });

    engine.set(
      reminder('blocked', {
        when: and(
          contentIncludes(['implement']),
          not(contentIncludes(['test'])),
        ),
      }),
      user('implement the test suite'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const text = getTextParts(messages[0]).join('');
    assert.ok(
      !text.includes('blocked'),
      `Expected not() to block. Got: ${text}`,
    );
  });

  it('works with everyNTurns and contentIncludes together', async () => {
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'compose-every',
      userId: 'u1',
    });

    engine.set(user('talk about cats'), assistantText('reply'));
    await engine.save();

    engine.set(
      reminder('db-every-2', {
        when: and(everyNTurns(2), contentIncludes(['database'])),
      }),
      user('query the database'),
    );
    await engine.save();

    const { messages } = await engine.resolve({ renderer: new XmlRenderer() });
    const lastMsg = messages[messages.length - 1];
    const text = getTextParts(lastMsg).join('');
    assert.ok(
      text.includes('db-every-2'),
      `Turn 2 + content match. Got: ${text}`,
    );
  });
});
