import { useEffect } from 'react';

type KeyHandler = (e: KeyboardEvent) => void;

interface UseKeyboardOptions {
  enabled?: boolean;
  handlers: Record<string, KeyHandler>;
}

/**
 * Build a normalized key string from a keyboard event.
 * Supports modifier combinations like "ctrl+i", "meta+shift+k".
 */
function getKeyCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

export function useKeyboard({ enabled = true, handlers }: UseKeyboardOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const keyCombo = getKeyCombo(e);
      // Check for exact combo match first (e.g., "ctrl+i")
      let handler = handlers[keyCombo];
      // Fall back to simple key match for non-modifier shortcuts
      if (!handler) {
        handler = handlers[e.key];
      }
      if (handler) {
        e.preventDefault();
        e.stopPropagation();
        handler(e);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, handlers]);
}
