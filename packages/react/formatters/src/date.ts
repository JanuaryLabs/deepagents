import { format, isValid, parseISO } from 'date-fns';

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function isISODateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

export function formatISODate(value: string): string {
  const date = parseISO(value);
  if (!isValid(date)) return value;
  const hasTime = value.includes('T') && !value.endsWith('T00:00:00.000Z');
  return hasTime
    ? format(date, 'MMM d, yyyy, h:mm a')
    : format(date, 'MMM d, yyyy');
}

export function formatAxisDate(
  value: string,
  granularity: 'day' | 'month' = 'month',
): string {
  const date = parseISO(value);
  if (!isValid(date)) return value;
  return granularity === 'day'
    ? format(date, 'MMM d')
    : format(date, 'MMM yyyy');
}
