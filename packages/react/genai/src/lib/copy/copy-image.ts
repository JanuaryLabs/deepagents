export const COPY_EXCLUSION_ATTRIBUTE = 'data-copy-exclude';

export const COPY_EXCLUSION_MODES = {
  image: 'image',
  assistantSnapshot: 'assistant-snapshot',
} as const;

export type CopyExclusionMode =
  (typeof COPY_EXCLUSION_MODES)[keyof typeof COPY_EXCLUSION_MODES];

type AttributeReader = {
  getAttribute(name: string): string | null;
};

type ClipboardLike = {
  write?: unknown;
  writeText?: unknown;
} | null;

export type CopyToClipboardStrategy = 'image' | 'text' | 'none';

function isAttributeReader(value: unknown): value is AttributeReader {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getAttribute' in value &&
    typeof value.getAttribute === 'function'
  );
}

export function hasCopyExclusion(
  node: unknown,
  mode: CopyExclusionMode,
): boolean {
  if (!isAttributeReader(node)) {
    return false;
  }

  const attributeValue = node.getAttribute(COPY_EXCLUSION_ATTRIBUTE);
  if (!attributeValue) {
    return false;
  }

  return attributeValue.split(/\s+/).includes(mode);
}

export function shouldIncludeInCopyImage(
  node: unknown,
  mode: CopyExclusionMode,
): boolean {
  return !hasCopyExclusion(node, mode);
}

export function resolveCopyToClipboardStrategy({
  clipboard,
  ClipboardItem,
}: {
  clipboard?: ClipboardLike;
  ClipboardItem?: unknown;
}): CopyToClipboardStrategy {
  if (
    typeof clipboard?.write === 'function' &&
    typeof ClipboardItem === 'function'
  ) {
    return 'image';
  }

  if (typeof clipboard?.writeText === 'function') {
    return 'text';
  }

  return 'none';
}
