import { format, formatRelative } from 'date-fns';

export function formatDateTime(date: Date | string): string {
  return format(date, 'PPpp');
}

export function formatRelativeTime(date: Date | string): string {
  return formatRelative(date, new Date());
}

export function formatShortDate(date: Date | string): string {
  return format(date, 'EEE MMM dd yyyy');
}
