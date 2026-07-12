/**
 * End-to-end probe for model-visible tool-output reminders.
 *
 * Requires Docker and a built @deepagents/context package. Run:
 * node packages/context/scripts/probe-tool-output-reminders.ts [output-dir]
 */
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import {
  type UIMessage,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/* eslint-disable @nx/enforce-module-boundaries -- This probe intentionally exercises the package's public entrypoints. */
import {
  ContextEngine,
  type FileChange,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createDockerSandbox,
  isSyntheticReminderMessage,
  reminder,
  stripReminders,
  toolOutput,
  withStraceFileChanges,
} from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';
import {
  type OpenAISpan,
  type OpenAITrace,
  type TracingProcessor,
  createOpenAITracesIntegration,
} from '@deepagents/context/tracing';

const outputDir = resolve(
  process.argv[2] ?? 'artifacts/tool-output-reminder-probe',
);
const telemetryPath = resolve(outputDir, 'telemetry.jsonl');
const summaryPath = resolve(outputDir, 'summary.json');
const evidencePath = resolve(outputDir, 'evidence.json');
const workdir = `/probe-${process.pid}`;
const writtenPath = `${workdir}/observed.txt`;
const reminderText = 'FILE CHANGE OBSERVED; inspect the raw tool outcome.';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function scriptedModel() {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'write-observed-file',
                toolName: 'bash',
                input: JSON.stringify({
                  command: `printf observed > ${writtenPath}`,
                  reasoning: 'Create one file so strace can verify the tool.',
                }),
              },
            ]
          : [
              { type: 'text-start', id: `text-${call}` },
              {
                type: 'text-delta',
                id: `text-${call}`,
                delta: call === 2 ? 'first turn complete' : 'replay complete',
              },
              { type: 'text-end', id: `text-${call}` },
            ];
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: call === 1 ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage,
      });
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return model;
}

function reminderTexts(prompt: LanguageModelV4Prompt): string[] {
  return prompt.flatMap((message) =>
    message.role === 'user' && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'text' && part.text.startsWith('<system-reminder>')
            ? [part.text]
            : [],
        )
      : [],
  );
}

function toolResultOutputs(prompt: LanguageModelV4Prompt): unknown[] {
  return prompt.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) =>
          part.type === 'tool-result' ? [part.output] : [],
        )
      : [],
  );
}

function textMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

function rawToolOutputs(messages: UIMessage[]): unknown[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      isToolUIPart(part) && part.state === 'output-available'
        ? [part.output]
        : [],
    ),
  );
}

await mkdir(outputDir, { recursive: true });

const traceItems: Array<OpenAITrace | OpenAISpan> = [];
const traceProcessor: TracingProcessor = {
  onTraceStart(trace) {
    traceItems.push(structuredClone(trace));
  },
  onSpanEnd(span) {
    traceItems.push(structuredClone(span));
  },
};
const telemetry = [
  createFileTelemetry({
    path: telemetryPath,
    append: false,
    includeTimestamp: false,
  }),
  createOpenAITracesIntegration({
    workflowName: 'tool-output-reminder-probe',
    processor: traceProcessor,
  }),
];

const fileChangeCalls: FileChange[][] = [];
const backend = await createDockerSandbox({
  dockerfile:
    'FROM debian:stable-slim\n' +
    'RUN apt-get update && apt-get install -y --no-install-recommends strace ' +
    '&& rm -rf /var/lib/apt/lists/*\n',
});
const tracked = await withStraceFileChanges(backend, {
  include: [workdir, `${workdir}/**`],
  onFileChanges(changes) {
    fileChangeCalls.push(structuredClone(changes));
  },
});
const sandbox = await createBashTool({
  sandbox: tracked,
  destination: workdir,
});

try {
  const setup = await sandbox.sandbox.executeCommand(`mkdir -p ${workdir}`);
  assert.equal(setup.exitCode, 0, setup.stderr);
  fileChangeCalls.length = 0;

  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'tool-output-reminder-probe',
    userId: 'probe',
  });
  let predicateSawRawFileMetadata = false;
  context.set(
    reminder(reminderText, {
      target: 'tool-output',
      when: toolOutput({
        name: 'bash',
        state: 'output-available',
        output(output) {
          const changes = (output as { meta?: { fileChanges?: FileChange[] } })
            .meta?.fileChanges;
          predicateSawRawFileMetadata =
            changes?.some(
              (change) => change.op === 'write' && change.path === writtenPath,
            ) ?? false;
          return predicateSawRawFileMetadata;
        },
      }),
    }),
  );

  const model = scriptedModel();
  const probeAgent = agent({
    name: 'tool-output-reminder-probe',
    context,
    model,
    sandbox,
    telemetry: { isEnabled: true, integrations: telemetry },
  });

  await context.continue(textMessage('Write the probe file.'));
  await drain(await chat(probeAgent, { generateTitle: false }));

  assert.equal(predicateSawRawFileMetadata, true);
  assert.ok(
    fileChangeCalls
      .flat()
      .some((change) => change.op === 'write' && change.path === writtenPath),
  );

  const postToolPrompt = model.doStreamCalls[1]?.prompt;
  assert.ok(postToolPrompt, 'expected a second model generation');
  assert.deepEqual(reminderTexts(postToolPrompt), [
    `<system-reminder>${reminderText}</system-reminder>`,
  ]);
  const toolMessageIndex = postToolPrompt.findIndex(
    (message) => message.role === 'tool',
  );
  const reminderMessageIndex = postToolPrompt.findIndex(
    (message) => reminderTexts([message]).length > 0,
  );
  assert.equal(reminderMessageIndex, toolMessageIndex + 1);

  const modelOutputs = toolResultOutputs(postToolPrompt);
  assert.equal(modelOutputs.length, 1);
  assert.doesNotMatch(JSON.stringify(modelOutputs), /fileChanges|meta/);

  const stored = await context.getMessages();
  const rawOutputs = rawToolOutputs(stored) as Array<{
    meta?: { fileChanges?: FileChange[] };
  }>;
  assert.equal(rawOutputs.length, 1);
  assert.ok(
    rawOutputs[0]?.meta?.fileChanges?.some(
      (change) => change.op === 'write' && change.path === writtenPath,
    ),
  );
  const synthetic = stored.find(isSyntheticReminderMessage);
  assert.equal(synthetic?.metadata?.synthetic.source, 'reminder');

  const visibleMessages = stored
    .filter((message) => !isSyntheticReminderMessage(message))
    .map(stripReminders);
  assert.doesNotMatch(JSON.stringify(visibleMessages), /FILE CHANGE OBSERVED/);

  await context.continue(textMessage('Verify replay.'));
  await drain(await chat(probeAgent, { generateTitle: false }));

  const replayPrompt = model.doStreamCalls[2]?.prompt;
  assert.ok(replayPrompt, 'expected a replay generation');
  assert.deepEqual(
    replayPrompt.slice(0, postToolPrompt.length),
    postToolPrompt,
  );

  const telemetryRecords = (await readFile(telemetryPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; data: unknown });
  const telemetryEvents = telemetryRecords.map((record) => record.event);
  for (const required of [
    'onStart',
    'onStepStart',
    'onToolExecutionStart',
    'onToolExecutionEnd',
    'onStepEnd',
    'onEnd',
  ]) {
    assert.ok(telemetryEvents.includes(required), `missing ${required}`);
  }

  const functionSpan = traceItems.find(
    (item): item is OpenAISpan =>
      item.object === 'trace.span' && item.span_data.type === 'function',
  );
  assert.ok(functionSpan, 'expected a traced bash function span');
  assert.equal(functionSpan.span_data.name, 'bash');
  assert.match(JSON.stringify(functionSpan.span_data.output), /fileChanges/);

  const summary = {
    passed: true,
    assertions: {
      predicateSawRawFileMetadata,
      fileChangeTracked: true,
      rawOutputStoredWithHostMetadata: true,
      modelOutputExcludedHostMetadata: true,
      modelOrdering: 'tool-result -> synthetic reminder -> next generation',
      promptReplayIsExactPrefix: true,
      syntheticReminderHiddenFromUiProjection: true,
      telemetryLifecycleRecorded: true,
      tracingFunctionSpanRecorded: true,
    },
    counts: {
      modelCalls: model.doStreamCalls.length,
      storedMessages: stored.length,
      telemetryRecords: telemetryRecords.length,
      traceItems: traceItems.length,
      fileChangeCallbacks: fileChangeCalls.length,
    },
    paths: {
      telemetry: telemetryPath,
      evidence: evidencePath,
      summary: summaryPath,
      writtenPath,
    },
  };
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        fileChangeCalls,
        postToolPrompt,
        replayPrompt,
        storedMessages: stored,
        visibleMessages,
        traceItems,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await sandbox.sandbox.dispose();
}
