export type PendingPrefill = {
  prompt: string;
  targetChatId: string;
  /** The id the prefill's message is sent under, the same on every attempt. */
  messageId: string;
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

export function writePrefill(data: Omit<PendingPrefill, 'messageId'>) {
  const prefill: PendingPrefill = { ...data, messageId: crypto.randomUUID() };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
}

export function clearPrefill() {
  sessionStorage.removeItem(STORAGE_KEY);
}
