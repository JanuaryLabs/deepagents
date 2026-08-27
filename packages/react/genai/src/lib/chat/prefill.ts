export type PendingPrefill = {
  prompt: string;
  targetChatId: string;
};

const STORAGE_KEY = 'pending-chat-prefill';

export function readPrefill(): PendingPrefill | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: PendingPrefill = JSON.parse(raw);
    return parsed;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function writePrefill(data: PendingPrefill) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearPrefill() {
  sessionStorage.removeItem(STORAGE_KEY);
}
