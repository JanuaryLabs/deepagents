import { z } from 'zod';

import { uploadReceiptSchema } from './zukhruf-chat-transport.ts';

const pendingPrefillSchema = z.strictObject({
  prompt: z.string(),
  targetChatId: z.string(),
  /** The id the prefill's message is sent under, the same on every attempt. */
  messageId: z.string(),
  /**
   * Receipts of the files uploaded under `targetChatId`, sent as the
   * message's `metadata.uploads`, as a submit with files sends them.
   */
  uploads: z.array(uploadReceiptSchema),
});

export type PendingPrefill = z.infer<typeof pendingPrefillSchema>;

const STORAGE_KEY = 'pending-chat-prefill';

export function readPrefill(): PendingPrefill | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return pendingPrefillSchema.parse(JSON.parse(raw));
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/**
 * Keeps a question for the chat `targetChatId` until that chat's transport
 * accepts it. It lives in `sessionStorage`, so a reload keeps it, and a `File`
 * cannot: upload the files first with the transport's
 * `uploadFile(targetChatId, file)` and pass the receipts as `uploads`.
 */
export function writePrefill({
  uploads = [],
  ...data
}: Omit<PendingPrefill, 'messageId' | 'uploads'> & {
  uploads?: PendingPrefill['uploads'];
}) {
  const prefill: PendingPrefill = {
    ...data,
    uploads,
    messageId: crypto.randomUUID(),
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(prefill));
}

export function clearPrefill() {
  sessionStorage.removeItem(STORAGE_KEY);
}
