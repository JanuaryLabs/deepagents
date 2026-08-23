import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodingAgent } from '@deepagents/demo-zukhruf-dynamic-subagents';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
} from '@deepagents/experimental/zukhruf';

test('builds the demo root in code and discovers its file agents through the runtime plugin', () => {
  const root = createCodingAgent(import.meta.dirname);
  const runtime = new AgentRuntime(root, {
    ...({} as AgentRuntimeOptions),
  });

  assert.deepEqual(
    runtime.info.agents.map(({ name, description, model }) => ({
      name,
      description,
      model: model.modelId,
    })),
    [
      {
        name: 'coding-agent',
        description: 'Implements focused changes in an existing repository.',
        model: runtime.info.agents[0].model.modelId,
      },
      {
        name: 'code-architect',
        description:
          "Designs one small implementation that fits the repository's existing modules.",
        model: runtime.info.agents[0].model.modelId,
      },
      {
        name: 'code-explorer',
        description:
          'Traces existing behavior, call sites, conventions, and relevant tests.',
        model: runtime.info.agents[0].model.modelId,
      },
      {
        name: 'code-reviewer',
        description:
          'Reviews the current diff for correctness, regressions, and needless complexity.',
        model: runtime.info.agents[0].model.modelId,
      },
    ],
  );
});
