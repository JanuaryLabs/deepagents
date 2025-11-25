export function wrapBlock(tag: string, children: string[]): string {
  const content = children
    .filter((child): child is string => Boolean(child))
    .join('\n');
  if (!content) {
    return '';
  }
  return `<${tag}>\n${indentBlock(content, 2)}\n</${tag}>`;
}

export function list(tag: string, values: string[], childTag: string): string {
  if (!values.length) {
    return '';
  }
  const children = values.map((value) => leaf(childTag, value)).join('\n');
  return `<${tag}>\n${indentBlock(children, 2)}\n</${tag}>`;
}

export function leaf(tag: string, value: string): string {
  const safe = escapeXml(value);
  if (safe.includes('\n')) {
    return `<${tag}>\n${indentBlock(safe, 2)}\n</${tag}>`;
  }
  return `<${tag}>${safe}</${tag}>`;
}

export function indentBlock(text: string, spaces: number): string {
  if (!text.trim()) {
    return '';
  }
  const padding = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length ? padding + line : padding))
    .join('\n');
}

export function escapeXml(value: string): string {
  return value
    .replaceAll(/&/g, '&amp;')
    .replaceAll(/</g, '&lt;')
    .replaceAll(/>/g, '&gt;')
    .replaceAll(/"/g, '&quot;')
    .replaceAll(/'/g, '&apos;');
}
