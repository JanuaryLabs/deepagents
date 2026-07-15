export type ForkTurns = 'none' | 'all' | number;

export const forkTurnsError =
  'fork_turns must be `none`, `all`, or a positive integer string';

export function parseForkTurns(value: string): ForkTurns | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'all') return normalized;
  if (!/^\d+$/.test(normalized)) return undefined;

  const turns = Number(normalized);
  return Number.isSafeInteger(turns) && turns > 0 ? turns : undefined;
}
