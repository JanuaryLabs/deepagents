import React from 'react';

export function MarkdownParagraph({
  children,
}: {
  children?: React.ReactNode;
}) {
  const childArray = React.Children.toArray(children);

  const hasCustomElement = childArray.some(
    (child) => React.isValidElement(child) && typeof child.type !== 'string',
  );

  if (!hasCustomElement) {
    return <p>{children}</p>;
  }

  const isAllCustom =
    childArray.length > 0 &&
    childArray.every(
      (child) => React.isValidElement(child) && typeof child.type !== 'string',
    );

  if (isAllCustom) {
    return children;
  }

  return <div>{children}</div>;
}
