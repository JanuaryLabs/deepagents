import {
  type GenerateTextResult,
  type InferUIMessageChunk,
  type StreamTextResult,
  type ToolCallOptions,
  type ToolSet,
  type UIDataTypes,
  type UIMessage,
  type UITools,
  generateId,
} from 'ai';
import { flow } from 'lodash-es';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { isPromise } from 'node:util/types';

import {
  visualizeMermaid,
  visualizeRichSemantic,
  visualizeSemantic,
} from './visualize.ts';

export async function streamWrite(response: StreamTextResult<ToolSet, never>) {
  response.consumeStream();
  const writeStream = createWriteStream('blog_writer_output.md');
  Readable.fromWeb(response.textStream as any).pipe(writeStream);

  // for await (const chunk of response.toUIMessageStream()) {
  //   if (chunk.type === 'reasoning-start') {
  //     writeStream.write('\n# reasoning\n');
  //   }
  //   if (chunk.type === 'reasoning-delta') {
  //     writeStream.write(chunk.delta);
  //   }
  //   if (chunk.type === 'reasoning-end') {
  //     writeStream.write('\n# /reasoning\n');
  //   }
  //   if (chunk.type === 'text-start') {
  //     writeStream.write('\n# text\n');
  //   }
  //   if (chunk.type === 'text-delta') {
  //     writeStream.write(chunk.delta);
  //   }
  //   if (chunk.type === 'text-end') {
  //     writeStream.write('\n# /text\n');
  //   }
  // }
  console.log(await response.totalUsage);
}

function printChunk(
  chunk: InferUIMessageChunk<UIMessage<unknown, UIDataTypes, UITools>>,
  options: { reasoning: boolean; wrapInTags: boolean; text: boolean },
) {
  const {
    reasoning: includeReasoning,
    wrapInTags,
    text: includeText,
  } = options;
  if (includeReasoning) {
    if (chunk.type === 'reasoning-start') {
      process.stdout.write(`\n${wrapInTags ? '<reasoning>' : ''}\n`);
    }
    if (chunk.type === 'reasoning-delta') {
      process.stdout.write(chunk.delta);
    }
    if (chunk.type === 'reasoning-end') {
      process.stdout.write(`\n${wrapInTags ? '</reasoning>' : ''}\n`);
    }
  }
  if (includeText) {
    if (chunk.type === 'text-start') {
      process.stdout.write(`\n${wrapInTags ? '<text>' : ''}\n`);
    }
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.delta);
    }
    if (chunk.type === 'text-end') {
      process.stdout.write(`\n${wrapInTags ? '</text>' : ''}\n`);
    }
  }
}

export const printer = {
  readableStream: async (
    stream: ReadableStream<
      InferUIMessageChunk<UIMessage<unknown, UIDataTypes, UITools>>
    >,
    options?: { reasoning?: boolean; wrapInTags?: boolean; text?: boolean },
  ) => {
    const includeReasoning = options?.reasoning ?? true;
    const wrapInTags = options?.wrapInTags ?? true;
    const includeText = options?.text ?? true;
    for await (const chunk of stream as any) {
      printChunk(chunk, {
        reasoning: includeReasoning,
        wrapInTags,
        text: includeText,
      });
    }
  },
  stdout: async (
    response: StreamTextResult<ToolSet, unknown>,
    options?: { reasoning?: boolean; text?: boolean; wrapInTags?: boolean },
  ) => {
    const includeReasoning = options?.reasoning ?? true;
    const includeText = options?.text ?? true;
    const wrapInTags = options?.wrapInTags ?? true;
    for await (const chunk of response.toUIMessageStream()) {
      printChunk(chunk, {
        reasoning: includeReasoning,
        text: includeText,
        wrapInTags,
      });
    }
    console.log(await response.totalUsage);
  },
  mermaid: flow(visualizeMermaid, console.log),
  semantic: flow(visualizeSemantic, console.log),
  richSemantic: flow(visualizeRichSemantic, console.log),
};

export function messageToUiMessage(message: string): UIMessage {
  return {
    id: generateId(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text: message,
      },
    ],
  };
}
export const user = messageToUiMessage;

export async function input(defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(
    `Please enter your input${defaultValue ? ` (default: ${defaultValue})` : ''}: `,
  );
  rl.close();
  return answer || defaultValue || '';
}

export async function confirm(
  message: string,
  defaultValue = true,
): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultText = defaultValue ? 'Y/n' : 'y/N';

  while (true) {
    const answer = await rl.question(`${message} (${defaultText}): `);
    const normalized = answer.toLowerCase().trim();

    // If empty answer, use default
    if (normalized === '') {
      rl.close();
      return defaultValue;
    }

    if (normalized === 'y' || normalized === 'yes') {
      rl.close();
      return true;
    } else if (normalized === 'n' || normalized === 'no') {
      rl.close();
      return false;
    } else {
      console.log(
        'Please answer with y/yes or n/no (or press Enter for default)',
      );
    }
  }
}

export async function last<T>(iterable: AsyncIterable<T>, position = -1) {
  const arr = await Array.fromAsync(iterable);
  return arr.at(position)!;
}
export async function finished<T>(iterable: AsyncIterable<T>) {
  await Array.fromAsync(iterable);
}

export function toOutput<T>(
  result:
    | Promise<GenerateTextResult<ToolSet, T>>
    | StreamTextResult<ToolSet, T>,
) {
  return isPromise(result)
    ? result.then((res) => res.experimental_output)
    : last(result.experimental_partialOutputStream);
}

export function toState<C>(options: ToolCallOptions) {
  return options.experimental_context as C;
}
