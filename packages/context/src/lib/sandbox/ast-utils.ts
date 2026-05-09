import type { ScriptNode, WordNode } from 'just-bash';
import { serialize } from 'just-bash';

export interface StaticWordTextOptions {
  preserveLegacyBackticks?: boolean;
}

export function asStaticWordText(
  word: WordNode | null | undefined,
  options: StaticWordTextOptions = {},
): string | null {
  if (!word) {
    return null;
  }
  return asStaticWordPartText(
    word.parts as unknown as Array<Record<string, unknown>>,
    options,
  );
}

export function asStaticWordPartText(
  parts: Array<Record<string, unknown>>,
  options: StaticWordTextOptions = {},
): string | null {
  let text = '';

  for (const part of parts) {
    const type = part.type;

    if (type === 'Literal' || type === 'SingleQuoted' || type === 'Escaped') {
      if (typeof part.value !== 'string') {
        return null;
      }
      text += part.value;
      continue;
    }

    if (type === 'DoubleQuoted') {
      if (!Array.isArray(part.parts)) {
        return null;
      }
      const inner = asStaticWordPartText(
        part.parts as Array<Record<string, unknown>>,
        options,
      );
      if (inner == null) {
        return null;
      }
      text += inner;
      continue;
    }

    if (
      options.preserveLegacyBackticks &&
      type === 'CommandSubstitution' &&
      part.legacy === true
    ) {
      text += '`' + serialize(part.body as ScriptNode).trim() + '`';
      continue;
    }

    return null;
  }

  return text;
}
