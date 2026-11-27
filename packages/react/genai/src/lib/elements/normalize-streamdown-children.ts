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

  let result = normalizeAttributeEscapes(
    normalizeCurlyQuotedAttributes(children, customTagTest(tagNames)),
  ).replace(
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

  result = result.replace(
    /\/>(\s*)</g,
    (match: string, space: string, offset: number, input: string) =>
      !space.includes('\n') && isProseLine(input, offset) ? match : '/>\n\n<',
  );

  return wrapElements(result, tagNames);
}

const TAG_PATTERN = /<\w[\w-]*(?:"(?:\\.|[^"])*"|[^>"])*>|<\/[\w-]+\s*>/g;

// A line that holds text besides its tags is prose: a tag there sits inside a
// sentence, as CommonMark reads inline HTML, while a tag alone on its line is a
// block.
function isProseLine(input: string, position: number): boolean {
  const start = input.lastIndexOf('\n', position - 1) + 1;
  const newline = input.indexOf('\n', position);
  const line = input.slice(start, newline < 0 ? input.length : newline);
  return line.replace(TAG_PATTERN, '').trim() !== '';
}

function customTagTest(tagNames?: string[]): (name: string) => boolean {
  const customSet = tagNames?.length ? new Set(tagNames) : null;
  return customSet
    ? (name: string) => customSet.has(name)
    : (name: string) => name.includes('-');
}

const CURLY_QUOTED_TAG =
  /<([\w-]+)((?:\s+[\w-]+=(?:[“”][^“”]*[“”]|[‘’][^‘’]*[‘’]|"[^"]*"|'[^']*'))+)\s*(\/?>)/g;
const CURLY_QUOTED_ATTRIBUTE =
  /([\w-]+)=(?:[“”]([^“”]*)[“”]|[‘’]([^‘’]*)[‘’])/g;

function straightenQuotes(attributes: string): string {
  return attributes.replace(
    CURLY_QUOTED_ATTRIBUTE,
    (_match: string, name: string, double?: string, single?: string) => {
      const value = double ?? single ?? '';
      return `${name}="${value.replace(/"/g, '&quot;')}"`;
    },
  );
}

// Models write typographic quotes around attribute values (passage=”…”), which
// HTML does not read as quotes, so a declared element would show as raw text.
function normalizeCurlyQuotedAttributes(
  input: string,
  isCustom: (name: string) => boolean,
): string {
  return input.replace(
    CURLY_QUOTED_TAG,
    (tag: string, name: string, attributes: string, close: string) =>
      isCustom(name) ? `<${name}${straightenQuotes(attributes)}${close}` : tag,
  );
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
  const isCustom = customTagTest(tagNames);

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
      const tag = input.slice(i, tagEnd + 1);
      if (nested) {
        out += '<div>' + tag + '</div>';
      } else if (isProseLine(input, i)) {
        // HTML has no self-closing custom elements: the parser would open
        // this one and take the rest of the sentence as its children.
        out +=
          '<span>' + tag.slice(0, -2).trimEnd() + '></' + tagName + '></span>';
      } else {
        out += tag;
        // A tag alone on its line is a block. Text on the next line needs a
        // blank line between, or the parser makes that text the tag's child.
        if (
          input[tagEnd + 1] === '\n' &&
          tagEnd + 2 < input.length &&
          input[tagEnd + 2] !== '\n'
        )
          out += '\n';
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
