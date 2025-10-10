import { createHash } from 'node:crypto';

export function cid(content: string) {
  return createHash('sha256').update(content).digest('hex');
}
