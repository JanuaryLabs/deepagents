import type { UIMessage } from 'ai';
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  MinusIcon,
} from 'lucide-react';
import { z } from 'zod';

import {
  Alert,
  AlertDescription,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Separator,
  Spinner,
} from '@deepagents/react-shadcn';

/**
 * The `data-compaction` payloads Zukhruf streams (`CompactionEvent`), as far as
 * this view reads them.
 */
const compactionEventSchema = z.discriminatedUnion('status', [
  z.object({
    id: z.string(),
    status: z.literal('restored'),
    sourceMessages: z.number(),
    replacementMessages: z.number(),
  }),
  z.object({
    id: z.string(),
    status: z.literal('started'),
    tokenScope: z.literal('request').optional(),
    triggerIndex: z.number(),
    targetTokens: z.number(),
    messageCount: z.number(),
  }),
  z.object({
    id: z.string(),
    status: z.literal('completed'),
    tokenScope: z.literal('request').optional(),
    tokens: z.object({ before: z.number(), after: z.number() }),
  }),
  z.object({
    id: z.string(),
    status: z.literal('failed'),
    phase: z.enum(['restore', 'evaluate', 'compact', 'persist']),
    reason: z.enum([
      'no-safe-boundary',
      'protected-history',
      'incomplete-summary',
      'empty-summary',
      'summary-too-large',
      'request-overhead',
      'error',
    ]),
  }),
]);

type CompactionEvent = z.infer<typeof compactionEventSchema>;

export function ChatCompaction({
  message,
  running,
}: {
  message: UIMessage;
  running: boolean;
}) {
  const events = message.parts.flatMap((part) => {
    if (part.type !== 'data-compaction') return [];
    const event = compactionEventSchema.safeParse(part.data);
    return event.success ? [event.data] : [];
  });
  const groups = Map.groupBy(events, (event) => event.id);
  return Array.from(groups, ([id, events]) => (
    <CompactionEntry key={id} events={events} running={running} />
  ));
}

function CompactionEntry({
  events,
  running,
}: {
  events: CompactionEvent[];
  running: boolean;
}) {
  const started = events.find((event) => event.status === 'started');
  const completed = events.find((event) => event.status === 'completed');
  const failed = events.find((event) => event.status === 'failed');
  const restored = events.find((event) => event.status === 'restored');
  const pending = started !== undefined && !completed && !failed;
  const label = failed
    ? 'Compaction failed'
    : completed
      ? 'Context compacted'
      : pending
        ? running
          ? 'Compacting context…'
          : 'Compaction interrupted'
        : 'Using saved summary';

  return (
    <Collapsible className="my-3">
      <CollapsibleTrigger className="group w-full text-left">
        <Item>
          <ItemMedia>
            {pending && running ? (
              <Spinner aria-label="Compacting context" />
            ) : failed ? (
              <CircleAlertIcon className="text-destructive size-4" />
            ) : completed ? (
              <CheckIcon className="size-4" />
            ) : (
              <MinusIcon className="size-4" />
            )}
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
            {completed && (
              <ItemDescription>
                {completed.tokens.before.toLocaleString()} →{' '}
                {completed.tokens.after.toLocaleString()} estimated{' '}
                {completed.tokenScope === 'request' ? 'input' : 'message'}{' '}
                tokens
              </ItemDescription>
            )}
          </ItemContent>
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        </Item>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Separator />
        <div className="space-y-3 px-3 py-3 text-sm">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
            {started && (
              <>
                <dt>Messages before compaction</dt>
                <dd>{started.messageCount.toLocaleString()}</dd>
                <dt>
                  Estimated{' '}
                  {started.tokenScope === 'request' ? 'input' : 'message'}{' '}
                  target
                </dt>
                <dd>{started.targetTokens.toLocaleString()} tokens</dd>
                <dt>Matched trigger</dt>
                <dd>#{started.triggerIndex + 1}</dd>
              </>
            )}
            {completed && (
              <>
                <dt>Checkpoint</dt>
                <dd>Saved</dd>
              </>
            )}
            {restored && (
              <>
                <dt>Using saved summary</dt>
                <dd>
                  {restored.sourceMessages} → {restored.replacementMessages}{' '}
                  messages
                </dd>
              </>
            )}
          </dl>
          {failed && (
            <Alert variant="destructive">
              <AlertDescription>
                {failed.phase}: {failed.reason}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
