import { cn } from './index.ts';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'text-muted-foreground rounded-md border px-2 py-1 font-mono text-[0.6875rem] capitalize',
        status === 'failed' && 'text-destructive border-destructive/30',
      )}
    >
      {status}
    </span>
  );
}
