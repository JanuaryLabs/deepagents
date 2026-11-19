import { ESLint } from 'eslint';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import tseslint from 'typescript-eslint';

import { rules } from './index.ts';

const ruleId = 'workspace/zukhruf-define-default-export';

/** Lints `code` as a TypeScript file of a Zukhruf app, with only this rule on. */
async function lint(code: string) {
  const eslint = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { workspace: { rules } },
      rules: { [ruleId]: 'error' },
    },
  });
  const [result] = await eslint.lintText(code, { filePath: 'app/agent.ts' });
  return result.messages.map(({ ruleId, line, message }) => ({
    ruleId,
    line,
    message,
  }));
}

test('a define* call that is the default export of its file passes', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineAgent } from '@deepagents/experimental/zukhruf';`,
      `export default defineAgent({ name: 'root' as const });`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, []);
});

test('a define* call bound to a named export is reported', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineAgent } from '@deepagents/experimental/zukhruf';`,
      `export const specialist = defineAgent({ name: 'specialist' });`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, [
    {
      ruleId,
      line: 2,
      message:
        'defineAgent() is the default export of its file: `export default defineAgent(…)`, or the value a default-exported function returns.',
    },
  ]);
});

test('a second define* call in a file is reported, even nested in the default export', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineSandbox, defineAgent } from '@deepagents/experimental/zukhruf';`,
      `export default defineAgent({`,
      `  sandbox: defineSandbox(() => backend),`,
      `});`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, [
    {
      ruleId,
      line: 3,
      message:
        'A file holds one Zukhruf define* call; move defineSandbox() to its own file.',
    },
  ]);
});

test('a define* call that a default-exported function returns passes', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineTool } from '@deepagents/experimental/zukhruf';`,
      `export default function replyToGroup(post: (message: string) => void) {`,
      `  return defineTool({ execute: post });`,
      `}`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, []);
});

test('a define* call that a default-exported arrow function returns passes', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineInstructions } from '@deepagents/experimental/zukhruf';`,
      `export default (name: string) => defineInstructions(name);`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, []);
});

test('a define* call that a named-exported function returns is reported', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineInstructions } from '@deepagents/experimental/zukhruf';`,
      `export function participantInstructions(name: string) {`,
      `  return defineInstructions(name);`,
      `}`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(
    findings.map(({ line }) => line),
    [3],
  );
});

test('a define* call returned from a function nested in the default export is reported', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineStack } from '@deepagents/experimental/zukhruf';`,
      `export default function participants(count: number) {`,
      `  for (let index = 0; index < count; index++) {`,
      `    return defineStack(async () => resources);`,
      `  }`,
      `}`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(
    findings.map(({ line }) => line),
    [4],
  );
});

test('a define* function imported under another name is reported by its import', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineTool as tool } from '@deepagents/experimental/zukhruf';`,
      `export const reply = tool({ execute: () => ({}) });`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, [
    {
      ruleId,
      line: 2,
      message:
        'defineTool() is the default export of its file: `export default defineTool(…)`, or the value a default-exported function returns.',
    },
  ]);
});

test('a define* function called through a namespace import is reported', async () => {
  // Act
  const findings = await lint(
    [
      `import * as zukhruf from '@deepagents/experimental/zukhruf';`,
      `export const root = zukhruf.defineAgent({ name: 'root' });`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(
    findings.map(({ line }) => line),
    [2],
  );
});

test('a define* function of another module is not a Zukhruf define* call', async () => {
  // Act
  const findings = await lint(
    [
      `import { defineAgent } from '@deepagents/experimental';`,
      `export const one = defineAgent({});`,
      `export const two = defineAgent({});`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, []);
});

test('a Zukhruf function that is not a define* function is not counted', async () => {
  // Act
  const findings = await lint(
    [
      `import {`,
      `  assertCommunication,`,
      `  defineAgent,`,
      `} from '@deepagents/experimental/zukhruf';`,
      `assertCommunication(first);`,
      `export default defineAgent({ name: 'root' });`,
    ].join('\n'),
  );

  // Assert
  assert.deepStrictEqual(findings, []);
});
