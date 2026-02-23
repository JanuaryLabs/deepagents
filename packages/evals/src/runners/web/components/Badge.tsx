import type { FC } from 'hono/jsx';

const styles: Record<string, string> = {
  running: 'badge-info',
  completed: 'badge-success',
  failed: 'badge-error',
};

const labels: Record<string, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'errored',
};

export const Badge: FC<{ status: string; id?: string }> = ({ status, id }) => (
  <span id={id} class={`badge badge-sm ${styles[status] ?? 'badge-ghost'}`}>
    {labels[status] ?? status}
  </span>
);
