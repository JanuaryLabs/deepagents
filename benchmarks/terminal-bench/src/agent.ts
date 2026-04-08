import type { LanguageModel } from 'ai';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  user,
} from '@deepagents/context';

import type { Bridge } from './bridge.ts';
import { type HarnessConfig, defaultConfig } from './config.ts';
import { contextInjection } from './middleware/context-injection.ts';
import { environmentBootstrap } from './middleware/environment-bootstrap.ts';
import type { Middleware } from './middleware/types.ts';
import { buildSystemFragments } from './prompts/system.ts';
import { createTools } from './tools/definitions.ts';

const DEFAULT_MIDDLEWARES: Middleware[] = [
  environmentBootstrap,
  contextInjection,
];

export async function runAgent(
  instruction: string,
  bridge: Bridge,
  model: LanguageModel,
  middlewares: Middleware[] = DEFAULT_MIDDLEWARES,
  config: HarnessConfig = defaultConfig,
) {
  const setupData: Record<string, string> = {};
  for (const mw of middlewares) {
    if (mw.onSetup) {
      const data = await mw.onSetup(instruction, bridge);
      Object.assign(setupData, data);
    }
  }

  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'tbench-run',
    userId: 'tbench-agent',
  });

  buildSystemFragments(
    context,
    instruction,
    setupData['envSnapshot'],
    setupData['discoveredContext'],
  );

  context.set(user(instruction));

  const tools = createTools(bridge);
  const tbAgent = agent({
    name: 'tbench',
    context,
    model,
    tools,
  });

  const maxRounds = 3;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let round = 0; round < maxRounds; round++) {
    const result = await tbAgent.generate({});

    if (result.usage) {
      totalInputTokens += result.usage.inputTokens ?? 0;
      totalOutputTokens += result.usage.outputTokens ?? 0;
    }

    const allToolCalls = result.steps.flatMap((s) => s.toolCalls);
    const completionCalls = allToolCalls.filter(
      (tc) => tc.toolName === 'task_complete',
    );
    const taskCompleted = completionCalls.length >= 2;

    if (taskCompleted) break;

    if (round < maxRounds - 1) {
      const lastText = result.text || 'No progress summary available.';
      context.set(
        user(
          `Continue working on the task. You have not yet completed it. ` +
            `Here is what happened so far: ${lastText.slice(0, 2000)}`,
        ),
      );
      await context.save({ branch: false });
    }
  }

  bridge.sendContext(totalInputTokens, totalOutputTokens);

  for (const mw of middlewares) {
    mw.onTeardown?.();
  }

  bridge.sendComplete();
}
