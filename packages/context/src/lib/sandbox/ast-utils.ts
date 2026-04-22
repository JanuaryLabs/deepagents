import type { WordNode } from 'just-bash';

export function asStaticWordText(
  word: WordNode | null | undefined,
): string | null {
  if (!word) {
    return null;
  }
  return asStaticWordPartText(
    word.parts as unknown as Array<Record<string, unknown>>,
  );
}

export function asStaticWordPartText(
  parts: Array<Record<string, unknown>>,
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
      );
      if (inner == null) {
        return null;
      }
      text += inner;
      continue;
    }

    return null;
  }

  return text;
}
