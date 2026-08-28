import type { ComposerDraftSource } from './ComposerTypes.ts';

const STORAGE_KEY_PREFIX = 'composer-draft:v1:';

export function readStoredDraft(key: string): ComposerDraftSource | null {
  const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${key}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isComposerDraftSource(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredDraft(
  key: string,
  source: ComposerDraftSource | null,
) {
  const storageKey = `${STORAGE_KEY_PREFIX}${key}`;
  if (!source || isEmptyDraftSource(source)) {
    localStorage.removeItem(storageKey);
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(source));
  } catch {
    // Quota exhaustion or privacy mode: the draft just won't survive a reload.
  }
}

function isEmptyDraftSource(source: ComposerDraftSource) {
  return (
    !source.persistedPrompt.trim() &&
    source.localImages.length === 0 &&
    source.remoteImages.length === 0 &&
    source.pendingPastes.length === 0
  );
}

function isComposerDraftSource(value: unknown): value is ComposerDraftSource {
  return (
    isRecord(value) &&
    typeof value.persistedPrompt === 'string' &&
    Array.isArray(value.localImages) &&
    Array.isArray(value.remoteImages) &&
    Array.isArray(value.pendingPastes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
