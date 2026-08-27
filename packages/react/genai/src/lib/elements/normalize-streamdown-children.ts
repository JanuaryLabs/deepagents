const OPENING_TAG_PATTERN = /<\w[\w-]*(?:"(?:\\.|[^"])*"|[^>"])*>/g;
const DOUBLE_QUOTED_ATTRIBUTE_PATTERN = /\b([\w-]+)="((?:\\.|[^"])*)"/g;

function normalizeAttributeEscapes(input: string): string {
  return input.replace(OPENING_TAG_PATTERN, (tag) =>
    tag.replace(
      DOUBLE_QUOTED_ATTRIBUTE_PATTERN,
      (_match: string, name: string, value: string) =>
        `${name}="${value.replace(/\\"/g, '&quot;')}"`,
    ),
  );
}

export function normalizeStreamdownChildren(
  children: string | undefined,
  tagNames?: string[],
) {
  if (typeof children !== 'string') {
    return children;
  }

  let result = normalizeAttributeEscapes(children).replace(
    /<(\w[\w-]*)((?:\s+[\w-]+="[^"]*")+)\s*(\/?>)/g,
    (_m, tag: string, attrs: string, close: string) => {
      const collapsed = attrs.replace(/\s+/g, ' ');
      const escaped = collapsed.replace(
        /"([^"]*)"/g,
        (_, v: string) => `"${v.replace(/\*/g, '&#42;')}"`,
      );
      return `<${tag}${escaped}${close}`;
    },
  );

  result = result.replace(/\/>\s*</g, '/>\n\n<');

  return wrapElements(result, tagNames);
}

/**
 * The wrapper divs emitted here must stay bare (no attributes). Their minimal
 * shape is part of the rendering contract, allowing consumers to make the
 * structural wrapper layout-transparent. Pinned by "top-level custom elements
 * stay wrapped in a bare class-less div" in InteractiveResponse.test.tsx.
 */
function wrapElements(
  input: string,
  tagNames?: string[],
  nested = false,
): string {
  const customSet = tagNames?.length ? new Set(tagNames) : null;
  const isCustom = customSet
    ? (name: string) => customSet.has(name)
    : (name: string) => name.includes('-');

  let out = '';
  let i = 0;

  while (i < input.length) {
    if (input[i] !== '<' || input[i + 1] === '/') {
      out += input[i++];
      continue;
    }

    let nameEnd = i + 1;
    while (nameEnd < input.length && /[\w-]/.test(input[nameEnd])) nameEnd++;
    const tagName = input.slice(i + 1, nameEnd);

    if (!tagName || !isCustom(tagName)) {
      out += input[i++];
      continue;
    }

    const tagEnd = skipToTagEnd(input, i);
    if (tagEnd < 0) {
      out += input[i++];
      continue;
    }

    if (input[tagEnd - 1] === '/') {
      if (nested) {
        out += '<div>' + input.slice(i, tagEnd + 1) + '</div>';
      } else {
        out += input.slice(i, tagEnd + 1);
      }
      i = tagEnd + 1;
      continue;
    }

    const close = findClosingTag(input, tagEnd + 1, tagName);
    if (!close) {
      // The model opened this element but never closed it (a dropped
      // </column> etc.). Inside a parent, adopt the rest of that parent's
      // content as children and auto-close, so siblings still wrap
      // symmetrically and Row's wrapper-flattening can't dissolve a bare one.
      if (nested) {
        const openTag = input.slice(i, tagEnd + 1);
        const processedInner = wrapElements(
          input.slice(tagEnd + 1),
          tagNames,
          true,
        );
        out += '<div>' + openTag + processedInner + '</' + tagName + '></div>';
        return out;
      }
      out += input.slice(i, tagEnd + 1);
      i = tagEnd + 1;
      continue;
    }

    const openTag = input.slice(i, tagEnd + 1);
    const innerContent = input.slice(tagEnd + 1, close.start);
    const closeTag = input.slice(close.start, close.end);
    const processedInner = wrapElements(innerContent, tagNames, true);

    if (nested) {
      out += '<div>' + openTag + processedInner + closeTag + '</div>';
    } else {
      out =
        ensureBlankLine(out) +
        '<div>' +
        openTag +
        processedInner +
        closeTag +
        '</div>';
    }
    i = close.end;
  }

  return out;
}

function skipToTagEnd(input: string, pos: number): number {
  let i = pos + 1;
  while (i < input.length) {
    if (input[i] === '"') {
      i++;
      while (i < input.length && input[i] !== '"') i++;
    } else if (input[i] === '>') {
      return i;
    }
    i++;
  }
  return -1;
}

function findClosingTag(
  input: string,
  start: number,
  tagName: string,
): { start: number; end: number } | null {
  let depth = 1;
  let i = start;
  const open = '<' + tagName;
  const close = '</' + tagName;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) return null;

    if (
      input.startsWith(close, lt) &&
      !/[\w-]/.test(input[lt + close.length] || '')
    ) {
      depth--;
      if (depth === 0) {
        const end = skipToTagEnd(input, lt);
        return end < 0 ? null : { start: lt, end: end + 1 };
      }
      const gt = input.indexOf('>', lt + close.length);
      i = gt < 0 ? lt + 1 : gt + 1;
    } else if (
      input.startsWith(open, lt) &&
      !/[\w-]/.test(input[lt + open.length] || '')
    ) {
      const end = skipToTagEnd(input, lt);
      if (end >= 0 && input[end - 1] !== '/') {
        depth++;
      }
      i = end < 0 ? lt + 1 : end + 1;
    } else if (/[a-zA-Z/]/.test(input[lt + 1] || '')) {
      const end = skipToTagEnd(input, lt);
      i = end < 0 ? lt + 1 : end + 1;
    } else {
      i = lt + 1;
    }
  }

  return null;
}

function ensureBlankLine(text: string): string {
  if (text.length === 0) return '\n\n';
  if (text.endsWith('\n\n')) return text;
  if (text.endsWith('\n')) return text + '\n';
  return text + '\n\n';
}
