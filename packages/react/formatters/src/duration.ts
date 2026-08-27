export function formatDurationBetween(
  start: Date | string,
  end: Date | string,
): string {
  const diffSec = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  if (diffSec < 60) return `${diffSec.toFixed(2)} s`;
  const diffMin = diffSec / 60;
  if (diffMin < 60) return `${diffMin.toFixed(2)} min`;
  return `${(diffMin / 60).toFixed(2)} h`;
}

export function formatDurationFromSeconds(seconds: number): string {
  const total = Math.abs(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
