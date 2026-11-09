import { simulateReadableStream } from 'ai';

import { usage } from './usage.fixture.ts';

export function textResult(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}

export function toolCallResult(call: {
  toolCallId: string;
  toolName: string;
  input: string;
}) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call' as const, ...call },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}
