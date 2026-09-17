import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodingAgent } from '@deepagents/demo-zukhruf-dynamic-subagents';
import { AgentRuntime } from '@deepagents/experimental/zukhruf';

import stack from './stack.ts';

test('builds the demo root in code and discovers its file agents through the runtime plugin', async () => {
  const root = createCodingAgent(import.meta.dirname);
  const runtime = new AgentRuntime(root);
  await using host = await runtime.initialize(stack);

  assert.deepEqual(
    host.info.agents.map(({ name, description, model }) => ({
      name,
      description,
      model: model.modelId,
    })),
    [
      {
        name: 'coding-agent',
        description: 'Implements focused changes in an existing repository.',
        model: host.info.agents[0].model.modelId,
      },
      {
        name: 'coding-team:code-architect',
        description:
          "Designs one small implementation that fits the repository's existing modules.",
        model: host.info.agents[0].model.modelId,
      },
      {
        name: 'coding-team:code-explorer',
        description:
          'Traces existing behavior, call sites, conventions, and relevant tests.',
        model: host.info.agents[0].model.modelId,
      },
      {
        name: 'coding-team:code-reviewer',
        description:
          'Reviews the current diff for correctness, regressions, and needless complexity.',
        model: host.info.agents[0].model.modelId,
      },
    ],
  );
});
