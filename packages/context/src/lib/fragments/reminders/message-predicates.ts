import { extractPlainText } from '../../text.ts';
import { type WhenPredicate } from '../message/user.ts';

export type CountSpec = { gte?: number; lte?: number; eq?: number };

export function assertCountSpec(spec: CountSpec): void {
  const hasEq = spec.eq !== undefined;
  const hasRange = spec.gte !== undefined || spec.lte !== undefined;
  if (!hasEq && !hasRange) {
    throw new Error('CountSpec must include at least one of gte/lte/eq');
  }
  if (hasEq && hasRange) {
    throw new Error('CountSpec.eq cannot be combined with gte/lte');
  }
}

export function checkCount(count: number, spec: CountSpec): boolean {
  if (spec.eq !== undefined) return count === spec.eq;
  if (spec.gte !== undefined && count < spec.gte) return false;
  if (spec.lte !== undefined && count > spec.lte) return false;
  return true;
}

export function lastAssistantLength(spec: CountSpec): WhenPredicate {
  assertCountSpec(spec);
  return (ctx) => {
    const message = ctx.lastAssistantMessage;
    const text = message ? extractPlainText(message) : '';
    return checkCount(text.length, spec);
  };
}
