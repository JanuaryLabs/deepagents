import { useActivePendingToolInput } from '../../../components/PendingToolInput.tsx';
import { TextShimmer } from '../../../components/text-shimmer.tsx';
import { useMessagesContext, useMessagesStatus } from '../messages-context.ts';
import { thinking } from './thinking-hint.ts';
import { TimelineDot } from './timeline-dot.tsx';
import { TimelineItem } from './timeline-item.tsx';

export function TrajectoryThinking() {
  const status = useMessagesStatus();
  const { messages } = useMessagesContext();
  const activePendingTool = useActivePendingToolInput();
  const thinkingHint = thinking(status, messages[messages.length - 1]);

  if (!thinkingHint || activePendingTool) return null;

  return (
    <TimelineItem className="mt-2" marker={<TimelineDot isLast />}>
      <span role="status">
        <TextShimmer
          as="span"
          className="text-muted-foreground line-clamp-2 font-mono text-xs"
        >
          {thinkingHint}
        </TextShimmer>
      </span>
    </TimelineItem>
  );
}
