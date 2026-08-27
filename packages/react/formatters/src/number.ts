import { EMPTY_PLACEHOLDER } from './constants.ts';

export interface NumberFormatOptions extends Intl.NumberFormatOptions {
  whenNullish?: string;
  locale?: string;
}

function intlOptions(opts?: NumberFormatOptions): Intl.NumberFormatOptions {
  if (!opts) return {};
  const intlOptions = { ...opts };
  delete intlOptions.whenNullish;
  delete intlOptions.locale;
  return intlOptions;
}

export function formatNumber(
  value: number | null | undefined,
  opts?: NumberFormatOptions,
): string {
  if (value == null || Number.isNaN(value)) {
    return opts?.whenNullish ?? EMPTY_PLACEHOLDER;
  }
  return new Intl.NumberFormat(
    opts?.locale ?? 'en-US',
    intlOptions(opts),
  ).format(value);
}

export const formatNullableNumber = formatNumber;

export function formatCompactNumber(
  value: number | null | undefined,
  opts?: NumberFormatOptions,
): string {
  return formatNumber(value, {
    notation: 'compact',
    maximumFractionDigits: 1,
    ...opts,
  });
}

export function formatCurrency(
  value: number | null | undefined,
  opts?: NumberFormatOptions,
): string {
  return formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    ...opts,
  });
}

export function formatPercent(
  value: number | null | undefined,
  opts?: NumberFormatOptions,
): string {
  if (value == null || Number.isNaN(value)) {
    return opts?.whenNullish ?? EMPTY_PLACEHOLDER;
  }
  return new Intl.NumberFormat(opts?.locale ?? 'en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    ...intlOptions(opts),
  }).format(value / 100);
}
