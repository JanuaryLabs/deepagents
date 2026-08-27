import { formatBoolean } from './boolean.ts';
import { NA_PLACEHOLDER, NULL_PLACEHOLDER } from './constants.ts';
import { formatISODate, isISODateString } from './date.ts';
import { formatCurrency, formatNumber } from './number.ts';

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return NULL_PLACEHOLDER;
  if (isISODateString(value)) return formatISODate(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export type ByTypeKind =
  'text' | 'number' | 'date' | 'boolean' | 'currency' | 'email' | 'url';

export function formatByType(value: unknown, type: ByTypeKind): string {
  if (value == null) return NA_PLACEHOLDER;
  switch (type) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'currency':
      return typeof value === 'number' ? formatCurrency(value) : String(value);
    case 'date': {
      if (isISODateString(value)) return formatISODate(value);
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        !(value instanceof Date)
      ) {
        return NA_PLACEHOLDER;
      }
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? NA_PLACEHOLDER
        : parsed.toLocaleDateString();
    }
    case 'boolean':
      return typeof value === 'boolean' ? formatBoolean(value) : String(value);
    case 'email':
    case 'url':
    case 'text':
      return String(value);
  }
}
