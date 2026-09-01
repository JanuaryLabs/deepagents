import { type StreamTextTransform, type ToolSet, smoothStream } from 'ai';
import { Parser } from 'htmlparser2';

/**
 * A `smoothStream` chunking detector that buffers an HTML-style element
 * until its root tag closes, so no partial custom tag ever reaches the
 * client mid-stream.
 *
 * - Regular text: chunks word-by-word (same as smoothStream's default)
 * - Elements: held until complete, including self-closing (`<kpi />`)
 * - Closing tags inside HTML comments are ignored
 * - Content passes through verbatim: `smoothStream` requires every detected
 *   chunk to be a prefix of its buffer, so rewriting (e.g. unescaping a
 *   literal `\n` in an attribute) belongs to the rendering client
 *
 * Boundary control only applies while consecutive text deltas stream:
 * `smoothStream` force-flushes its buffer when a non-text chunk arrives, so
 * an element left unclosed at the end of a text part is emitted raw.
 */
export function elementChunking(): (buffer: string) => string | null {
  const WORD_REGEX = /\S+\s+/m;

  return (buffer: string): string | null => {
    if (!buffer.startsWith('<')) {
      const ltIndex = buffer.indexOf('<');
      if (ltIndex > 0) {
        const textBefore = buffer.slice(0, ltIndex);
        const wordMatch = WORD_REGEX.exec(textBefore);
        if (wordMatch) {
          return textBefore.slice(0, wordMatch.index + wordMatch[0].length);
        }
        return textBefore;
      }
      const wordMatch = WORD_REGEX.exec(buffer);
      if (wordMatch) {
        return buffer.slice(0, wordMatch.index + wordMatch[0].length);
      }
      return null;
    }

    // A `<` not opening a tag (e.g. `< ` or `<123`) is plain text
    if (!/^<[a-z]/i.test(buffer)) {
      const wordMatch = WORD_REGEX.exec(buffer);
      if (wordMatch) {
        return buffer.slice(0, wordMatch.index + wordMatch[0].length);
      }
      return null;
    }

    // `<bar` could still become `<bar-chart`; wait for the name to finish
    if (/^<[a-z][a-z0-9-]*$/i.test(buffer)) {
      return null;
    }

    let elementEnd = -1;
    let depth = 0;
    let rootTagName: string | null = null;

    const parser = new Parser(
      {
        onopentag(name) {
          if (rootTagName === null) {
            rootTagName = name;
          }
          depth++;
        },
        onclosetag(name) {
          depth--;
          // First completed root element wins: without the guard, a later
          // same-name sibling in the buffer would keep pushing elementEnd
          // forward, merging separate elements (and any text between them)
          // into one chunk
          if (elementEnd === -1 && depth === 0 && name === rootTagName) {
            elementEnd = parser.endIndex + 1;
          }
        },
      },
      {
        recognizeSelfClosing: true,
        lowerCaseTags: true,
      },
    );

    // No parser.end(): it would auto-close a dangling tag and report a
    // still-incomplete element as finished
    parser.write(buffer);

    if (elementEnd !== -1) {
      return buffer.slice(0, elementEnd);
    }

    return null;
  };
}

// smoothStream's return type is narrower than the exported StreamTextTransform
// (no stopStream param), so we bridge by dropping stopStream before forwarding.
const smoothFactory = smoothStream({ chunking: elementChunking() });

/**
 * Element-safe replacement for the default `smoothStream()` transform. Pass
 * it to `chat()`/`agent.stream()` whenever an element catalog is active:
 *
 * ```ts
 * const stream = await chat(agent, { transform: [elementsStreamTransform] });
 * ```
 */
export const elementsStreamTransform: StreamTextTransform<ToolSet> = (
  options,
) => smoothFactory({ tools: options.tools });
