import type * as models from '../index.ts';

export type RunRow = {
  config: { [key: string]: any };
  finished_at: number;
  id: string;
  model: string;
  name: string;
  started_at: number;
  status: 'running' | 'completed' | 'failed';
  suite_id: string;
  summary: models.RunSummary;
};
