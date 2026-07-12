#!/usr/bin/env node
// Validate JSON fixtures against AI SDK v7's LanguageModelV4 stream lifecycle.
// The SDK exports stream builders and collectors, but no public semantic validator.
import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const VALID_UNIFIED = new Set([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
]);

const REQUIRED_FIELDS = {
  'stream-start': ['warnings'],
  'response-metadata': [],
  'text-start': ['id'],
  'text-delta': ['id', 'delta'],
  'text-end': ['id'],
  'reasoning-start': ['id'],
  'reasoning-delta': ['id', 'delta'],
  'reasoning-end': ['id'],
  'tool-input-start': ['id', 'toolName'],
  'tool-input-delta': ['id', 'delta'],
  'tool-input-end': ['id'],
  'tool-approval-request': ['approvalId', 'toolCallId'],
  'tool-call': ['toolCallId', 'toolName', 'input'],
  'tool-result': ['toolCallId', 'toolName', 'result'],
  custom: ['kind'],
  source: ['sourceType', 'id'],
  file: ['mediaType', 'data'],
  'reasoning-file': ['mediaType', 'data'],
  finish: ['usage', 'finishReason'],
  error: ['error'],
  raw: ['rawValue'],
};

function validate(chunks) {
  const problems = [];
  if (!Array.isArray(chunks)) return ['top-level: expected an array of chunks'];

  const open = {
    text: new Set(),
    reasoning: new Set(),
    'tool-input': new Set(),
  };
  let seenFinish = false;

  for (const [index, chunk] of chunks.entries()) {
    const at = `chunks[${index}]`;
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      problems.push(`${at}: expected an object`);
      continue;
    }
    if (seenFinish) problems.push(`${at}: appears after terminal finish`);
    if ('textDelta' in chunk) {
      problems.push(`${at}: textDelta is not a V4 field; use delta`);
    }

    const required = REQUIRED_FIELDS[chunk.type];
    if (!required) {
      problems.push(`${at}: unknown V4 chunk type '${chunk.type}'`);
      continue;
    }
    for (const field of required) {
      if (!(field in chunk)) problems.push(`${at}: missing '${field}'`);
    }

    const match = /^(text|reasoning|tool-input)-(start|delta|end)$/.exec(
      chunk.type,
    );
    if (match) {
      const [, kind, phase] = match;
      if (phase === 'start') {
        if (open[kind].has(chunk.id)) {
          problems.push(`${at}: duplicate ${kind}-start for '${chunk.id}'`);
        }
        open[kind].add(chunk.id);
      } else if (!open[kind].has(chunk.id)) {
        problems.push(
          `${at}: ${kind}-${phase} has no open start for '${chunk.id}'`,
        );
      } else if (phase === 'end') {
        open[kind].delete(chunk.id);
      }
    }

    if (chunk.type === 'tool-call' && typeof chunk.input !== 'string') {
      problems.push(`${at}: tool-call input must be stringified JSON`);
    }
    if (chunk.type === 'custom' && !String(chunk.kind).includes('.')) {
      problems.push(`${at}: custom kind must use the provider.kind format`);
    }
    if (chunk.type === 'finish') {
      seenFinish = true;
      const reason = chunk.finishReason;
      if (!reason || typeof reason !== 'object') {
        problems.push(`${at}: finishReason must be { unified, raw }`);
      } else {
        if (!VALID_UNIFIED.has(reason.unified)) {
          problems.push(
            `${at}: invalid unified finish reason '${reason.unified}'`,
          );
        }
        if (!('raw' in reason))
          problems.push(`${at}: finishReason is missing 'raw'`);
      }
      const usage = chunk.usage;
      if (!usage?.inputTokens || !usage?.outputTokens) {
        problems.push(
          `${at}: usage must use nested V4 inputTokens/outputTokens`,
        );
      }
    }
  }

  if (!seenFinish) problems.push("stream: missing terminal 'finish' chunk");
  for (const [kind, ids] of Object.entries(open)) {
    for (const id of ids)
      problems.push(`stream: ${kind} '${id}' was never closed`);
  }
  return problems;
}

let chunks;
try {
  chunks = JSON.parse(
    readFileSync(argv[2] === '-' || !argv[2] ? 0 : argv[2], 'utf8'),
  );
} catch (error) {
  console.error(`JSON parse error: ${error.message}`);
  exit(1);
}

const problems = validate(chunks);
if (problems.length === 0) {
  console.log('OK — chunks conform to the AI SDK v7 V4 stream lifecycle.');
  exit(0);
}
for (const problem of problems) console.error(`✗ ${problem}`);
exit(1);
