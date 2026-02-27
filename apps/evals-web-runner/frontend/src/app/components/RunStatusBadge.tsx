import { Badge } from '../shadcn/index.ts';

const variantMap: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
};

export function RunStatusBadge({ status }: { status: string }) {
  return <Badge variant={variantMap[status] ?? 'outline'}>{status}</Badge>;
}
