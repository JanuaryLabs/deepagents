import type { WordNode } from 'just-bash';
import { serialize } from 'just-bash';

type WordPart = WordNode['parts'][number];

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
  return asStaticWordPartText(word.parts, options);
}

export function asStaticWordPartText(
  parts: readonly WordPart[],
  options: StaticWordTextOptions = {},
): string | null {
  const texts: string[] = [];

  for (const part of parts) {
    const text = staticPartText(part, options);
    if (text == null) {
      return null;
    }
    texts.push(text);
  }

  return texts.join('');
}

function staticPartText(
  part: WordPart,
  options: StaticWordTextOptions,
): string | null {
  switch (part.type) {
    case 'Literal':
    case 'SingleQuoted':
    case 'Escaped':
      return part.value;
    case 'DoubleQuoted':
      return asStaticWordPartText(part.parts, options);
    case 'CommandSubstitution':
      return options.preserveLegacyBackticks && part.legacy
        ? '`' + serialize(part.body).trim() + '`'
        : null;
    default:
      return null;
  }
}
