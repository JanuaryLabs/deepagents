import { performance } from 'node:perf_hooks';

const enabled = process.env.PROFILE === '1' || process.env.PROFILE === 'true';
const phases: Array<{ label: string; ms: number }> = [];

export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    phases.push({ label, ms: performance.now() - start });
  }
}

export function report(): void {
  if (!enabled || phases.length === 0) return;
  const total = phases.reduce((sum, p) => sum + p.ms, 0);
  const width = Math.max(...phases.map((p) => p.label.length), 'TOTAL'.length);
  const line = (label: string, ms: number) =>
    `[profile] ${label.padEnd(width)}  ${`${ms.toFixed(0)}ms`.padStart(8)}`;
  console.log('');
  for (const p of phases) console.log(line(p.label, p.ms));
  console.log(line('TOTAL', total));
}
