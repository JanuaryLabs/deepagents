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

/**
 * Custom chunking function for smoothStream that buffers HTML elements until complete.
 *
 * This solves the problem of streaming HTML elements with multiline attributes
 * (like SQL queries) where partial elements would break frontend parsing.
 *
 * Behavior:
 * - Regular text: chunks word-by-word (same as smoothStream default)
 * - HTML elements: buffers until the entire element is complete (including closing tag)
 *
 * Supports:
 * - Single-word elements: `<kpi>`, `<div>`
 * - Kebab-case elements: `<bar-chart>`, `<data-table>`
 * - Self-closing elements: `<kpi />`
 * - Elements with content: `<kpi>...</kpi>`
 * - Quoted attributes with all quote types: `"`, `'`, `` ` ``
 * - Escaped quotes within attributes
 * - Nested elements of the same type
 *
 * @example
 * ```typescript
 * import { smoothStream } from 'ai';
 *
 * streamText({
 *   // ...
 *   experimental_transform: smoothStream({
 *     chunking: htmlElementChunking(),
 *   }),
 * });
 * ```
 */
export function htmlElementChunking(): (buffer: string) => string | null {
  const WORD_REGEX = /\S+\s+/m;

  return (buffer: string): string | null => {
    // Check if buffer starts with potential HTML element
    if (buffer.startsWith('<')) {
      // Check if this could be an element (starts with < followed by a letter)
      if (/^<[a-z]/i.test(buffer)) {
        // Check if we have an incomplete element name (no terminator yet)
        // e.g., `<bar` could become `<bar-chart`
        if (/^<[a-z][a-z0-9-]*$/i.test(buffer)) {
          // Buffer more to see if name is complete
          return null;
        }

        // Check if it's a valid element start with complete name
        const elementMatch = /^<([a-z][a-z0-9]*(?:-[a-z0-9]+)*)([\s/>])/i.exec(
          buffer,
        );
        if (elementMatch) {
          const elementName = elementMatch[1];
          const endIndex = findElementEnd(buffer, elementName);
          if (endIndex === -1) {
            // Element not complete yet
            return null;
          }
          // Return complete element
          return buffer.slice(0, endIndex);
        }
      }
      // `<` followed by non-letter or invalid pattern, treat as text
    }

    // Check if there's an element start later in the buffer
    const ltIndex = buffer.indexOf('<');
    if (ltIndex > 0) {
      // There's text before a potential element
      const textBefore = buffer.slice(0, ltIndex);
      // Chunk the text before (word by word)
      const wordMatch = WORD_REGEX.exec(textBefore);
      if (wordMatch) {
        return textBefore.slice(0, wordMatch.index + wordMatch[0].length);
      }
      // No complete word, return all text before element
      return textBefore;
    }

    // No element in buffer - use word chunking
    const wordMatch = WORD_REGEX.exec(buffer);
    if (wordMatch) {
      return buffer.slice(0, wordMatch.index + wordMatch[0].length);
    }

    // No complete word - return null to buffer more
    return null;
  };
}

/**
 * Finds the end index of an HTML element in the buffer.
 *
 * Handles:
 * - Self-closing elements: `<foo />` returns index after `>`
 * - Elements with content: `<foo>...</foo>` returns index after closing `>`
 * - Quoted attributes with escaped quotes
 * - Nested elements of the same type
 *
 * @returns The index after the element ends, or -1 if element is incomplete
 */
function findElementEnd(buffer: string, elementName: string): number {
  // Find where the element name ends in the buffer
  const nameEndIndex = buffer.indexOf(elementName) + elementName.length;

  type QuoteChar = '"' | "'" | '`';
  let inQuote: QuoteChar | null = null;
  let escaped = false;
  let openTagClosed = false;
  let depth = 0;

  for (let i = nameEndIndex; i < buffer.length; i++) {
    const char = buffer[i];
    const prevChar = i > 0 ? buffer[i - 1] : '';

    // Handle escape sequences
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    // Handle quotes
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inQuote = char as QuoteChar;
      continue;
    }

    // Not in quotes - check for tag boundaries

    if (!openTagClosed) {
      // Still in opening tag, looking for > or />
      if (char === '>' && prevChar === '/') {
        // Self-closing element
        return i + 1;
      }
      if (char === '>') {
        openTagClosed = true;
      }
      continue;
    }

    // Opening tag is closed, looking for </elementName>

    // Check for closing tag (case-insensitive to match HTML behavior)
    const closingTagLength = elementName.length + 3; // "</" + name + ">"
    const potentialClosingTag = buffer.slice(i, i + closingTagLength);
    if (
      potentialClosingTag.toLowerCase() === `</${elementName.toLowerCase()}>`
    ) {
      if (depth === 0) {
        return i + closingTagLength;
      }
      depth--;
      i += closingTagLength - 1; // -1 because loop will increment
      continue;
    }

    // Check for nested opening tag of same element type (case-insensitive)
    const openingTagLength = elementName.length + 1; // "<" + name
    const potentialOpeningTag = buffer.slice(i, i + openingTagLength);
    if (potentialOpeningTag.toLowerCase() === `<${elementName.toLowerCase()}`) {
      const afterName = buffer[i + openingTagLength];
      // Valid element start if followed by whitespace, >, /, or newline
      if (
        afterName === ' ' ||
        afterName === '>' ||
        afterName === '/' ||
        afterName === '\n' ||
        afterName === '\t'
      ) {
        depth++;
      }
    }
  }

  // Element not complete
  return -1;
}
