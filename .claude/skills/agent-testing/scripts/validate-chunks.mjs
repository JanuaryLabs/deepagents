#!/usr/bin/env node
// Validates an array of LanguageModelV3 stream chunks against the V3 protocol rules.
// Usage:
//   node validate-chunks.mjs chunks.json
//   echo '[{"type":"text-delta","id":"t1","delta":"hi"}]' | node validate-chunks.mjs -
//
// Catches the bugs the skill's "Gotchas" list warns about, before the SDK silently
// swallows them. Exits 0 if valid, 1 with a message per problem if not.
import { readFileSync } from 'node:fs';
import { argv, exit, stdin } from 'node:process';

const VALID_UNIFIED = new Set([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
]);

const STREAM_PART_SHAPES = {
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
  'tool-call': ['toolCallId', 'toolName', 'input'],
  'tool-result': ['toolCallId', 'toolName', 'result'],
  source: ['sourceType', 'id'],
  file: ['mediaType', 'data'],
  finish: ['usage', 'finishReason'],
  error: ['error'],
  raw: ['rawValue'],
  'tool-approval-request': ['approvalId', 'toolCallId'],
};

function readInput() {
  if (argv[2] === '-' || argv.length < 3) {
    return readFileSync(0, 'utf8');
  }
  return readFileSync(argv[2], 'utf8');
}

function validate(chunks) {
  const problems = [];
  if (!Array.isArray(chunks)) {
    problems.push('top-level: expected an array of chunks');
    return problems;
  }

  const openIds = {
    text: new Set(),
    reasoning: new Set(),
    'tool-input': new Set(),
  };
  let seenFinish = false;

  chunks.forEach((chunk, i) => {
    const at = `chunks[${i}]`;
    if (!chunk || typeof chunk !== 'object') {
      problems.push(`${at}: not an object`);
      return;
    }
    if (seenFinish) {
      problems.push(`${at}: chunks after 'finish' are never emitted`);
    }
    const { type } = chunk;
    if (!type) {
      problems.push(`${at}: missing 'type' field`);
      return;
    }

    // V2 holdover
    if ('textDelta' in chunk) {
      problems.push(
        `${at}: field 'textDelta' is V2; V3 uses 'delta'. The SDK will silently drop this text.`,
      );
    }

    const shape = STREAM_PART_SHAPES[type];
    if (!shape) {
      problems.push(`${at}: unknown chunk type '${type}'`);
      return;
    }
    for (const required of shape) {
      if (!(required in chunk)) {
        problems.push(`${at} (${type}): missing required field '${required}'`);
      }
    }

    // Content stream lifecycle
    if (type === 'text-start') openIds.text.add(chunk.id);
    if (type === 'text-delta' && !openIds.text.has(chunk.id)) {
      problems.push(
        `${at}: text-delta with id '${chunk.id}' has no preceding text-start`,
      );
    }
    if (type === 'text-end') {
      if (!openIds.text.has(chunk.id)) {
        problems.push(
          `${at}: text-end with id '${chunk.id}' has no matching text-start`,
        );
      }
      openIds.text.delete(chunk.id);
    }

    if (type === 'reasoning-start') openIds.reasoning.add(chunk.id);
    if (type === 'reasoning-delta' && !openIds.reasoning.has(chunk.id)) {
      problems.push(
        `${at}: reasoning-delta id '${chunk.id}' has no preceding reasoning-start`,
      );
    }
    if (type === 'reasoning-end') openIds.reasoning.delete(chunk.id);

    if (type === 'tool-input-start') openIds['tool-input'].add(chunk.id);
    if (type === 'tool-input-delta' && !openIds['tool-input'].has(chunk.id)) {
      problems.push(
        `${at}: tool-input-delta id '${chunk.id}' has no preceding tool-input-start`,
      );
    }
    if (type === 'tool-input-end') openIds['tool-input'].delete(chunk.id);

    if (type === 'tool-call' && typeof chunk.input !== 'string') {
      problems.push(
        `${at}: tool-call 'input' must be a stringified JSON, got ${typeof chunk.input}`,
      );
    }

    if (type === 'finish') {
      seenFinish = true;
      const fr = chunk.finishReason;
      if (!fr || typeof fr !== 'object') {
        problems.push(
          `${at}: finishReason must be an object { unified, raw }, not a bare value`,
        );
      } else if (!VALID_UNIFIED.has(fr.unified)) {
        problems.push(
          `${at}: finishReason.unified '${fr.unified}' is not one of ${[...VALID_UNIFIED].join(', ')}`,
        );
      }
    }
  });

  if (!seenFinish) {
    problems.push("stream: missing terminal 'finish' chunk");
  }
  for (const kind of ['text', 'reasoning', 'tool-input']) {
    for (const id of openIds[kind]) {
      problems.push(
        `stream: ${kind} id '${id}' was never closed with ${kind}-end`,
      );
    }
  }

  return problems;
}

const raw = await Promise.resolve(readInput());
let chunks;
try {
  chunks = JSON.parse(raw);
} catch (e) {
  console.error('JSON parse error:', e.message);
  exit(1);
}

const problems = validate(chunks);
if (problems.length === 0) {
  console.log('OK — stream chunks conform to the V3 protocol.');
  exit(0);
}
for (const p of problems) console.error('✗', p);
exit(1);
