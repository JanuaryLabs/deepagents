export function reconstructPersistedPromptSelection(
  root: HTMLElement,
  selection: Selection | null,
) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const fragment = range.cloneContents();
  for (const element of fragment.querySelectorAll('[data-persisted-source]')) {
    const source = element.getAttribute('data-persisted-source');
    if (source !== null) element.replaceWith(source);
  }
  return fragment.textContent ?? '';
}
