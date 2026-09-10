import { z } from 'zod';

export const childActivitySchema = z.object({
  id: z.string(),
  type: z.enum(['spawn', 'message', 'followup', 'interrupt', 'completion']),
  at: z.number(),
  actorPath: z.string(),
  targetPath: z.string(),
  streamId: z.string(),
  outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
});

export type ChildActivity = z.infer<typeof childActivitySchema>;

/** One receipt per operation kind, never a transcript or an activity log. */
export const childActivitiesSchema = z.partialRecord(
  childActivitySchema.shape.type,
  childActivitySchema,
);

export const childActivityMetadataSchema = z.looseObject({
  childActivities: childActivitiesSchema.default({}),
});

export interface ChildProgress {
  chatId: string;
  treeId: string;
  path: string;
  parentChatId: string;
  declarationName: string;
  state:
    | 'pending'
    | 'queued'
    | 'running'
    | 'waitingOnApproval'
    | 'waitingOnUserInput'
    | 'completed'
    | 'failed'
    | 'interrupted';
  activities: Partial<Record<ChildActivity['type'], ChildActivity>>;
}
