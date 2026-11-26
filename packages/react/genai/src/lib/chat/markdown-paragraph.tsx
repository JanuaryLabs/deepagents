import React from 'react';

// The tags streamdown draws as inline content: HTML's phrasing content, less
// img, which streamdown wraps in block <div>s.
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

// A component stands for the tag in the hast node streamdown passes it. An
// interactive element's own tag is not phrasing, so it counts as a block
// unless the normalizer placed it inline, inside a bare <span>.
function isBlock(child: React.ReactNode): boolean {
  if (!React.isValidElement<{ node?: { tagName?: string } }>(child))
    return false;
  const tag =
    typeof child.type === 'string' ? child.type : child.props.node?.tagName;
  return tag === undefined || !INLINE_TAGS.has(tag);
}

// A block inside a <p> is invalid HTML, so a paragraph that holds one becomes
// a <div>, and one that holds only blocks keeps no wrapper.
export function MarkdownParagraph({
  children,
  dir,
}: {
  children?: React.ReactNode;
  dir?: string;
}) {
  const childArray = React.Children.toArray(children);

  if (!childArray.some(isBlock)) {
    return <p dir={dir}>{children}</p>;
  }

  if (childArray.every(isBlock)) {
    return children;
  }

  return <div dir={dir}>{children}</div>;
}
