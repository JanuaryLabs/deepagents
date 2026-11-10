import { hash } from 'node:crypto';

export function cid(content: string) {
  return hash('sha256', content);
}
