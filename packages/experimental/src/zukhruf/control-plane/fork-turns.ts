export type ForkTurns = 'none' | 'all';

export const forkTurnsError = 'fork_turns must be `none` or `all`';

/** Omitted or blank `fork_turns` forks the full parent history. */
export function parseForkTurns(
  value: string | undefined,
): ForkTurns | undefined {
  const normalized = value?.trim().toLowerCase() || 'all';
  return normalized === 'none' || normalized === 'all' ? normalized : undefined;
}
