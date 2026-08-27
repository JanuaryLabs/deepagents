import type { ToolUIPart } from 'ai';
import { BanIcon } from 'lucide-react';
import { type ReactNode, use } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
} from '@deepagents/react-shadcn';

import type { ToolLabel } from '../../../tools/registry.ts';
import { UnicodeSpinner } from '../../../ui/UnicodeSpinner.tsx';
import { ToolSegmentMarkerContext } from '../segments/index.tsx';
import { ToolLabelBlock } from '../tool-label.tsx';
import { TimelineDot } from './timeline-dot.tsx';
import { TimelineItem } from './timeline-item.tsx';

function TimelineIconMarker({
  Icon,
  isLast,
  isLoading,
  aborted,
  state,
  isError,
}: {
  Icon: NonNullable<ToolLabel['icon']>;
  isLast: boolean;
  isLoading: boolean;
  aborted: boolean;
  state?: ToolUIPart['state'];
  isError: boolean;
}) {
  return (
    <div className="absolute top-0 left-0 flex h-full flex-col items-center">
      {isLoading ? (
        <UnicodeSpinner className="text-muted-foreground z-10 shrink-0 text-sm" />
      ) : aborted ? (
        <BanIcon className="text-destructive z-10 size-3.5 shrink-0" />
      ) : (
        <Icon
          className={cn(
            'z-10 size-3.5 shrink-0',
            state === 'output-error' || isError
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        />
      )}

      {!isLast && <span className="bg-border w-px flex-1" />}
    </div>
  );
}

function TimelineRow({
  isLast,
  label,
  state,
  aborted,
  children,
}: {
  isLast: boolean;
  label?: ToolLabel;
  state?: ToolUIPart['state'];
  aborted?: boolean;
  children: ReactNode;
}) {
  const toolMarker = use(ToolSegmentMarkerContext);
  const effectiveLabel = label ?? toolMarker?.label;
  const effectiveState = state ?? toolMarker?.state;
  const effectiveAborted = aborted ?? toolMarker?.aborted ?? false;

  const Icon = effectiveLabel?.icon;
  const isLoading =
    !!effectiveState &&
    !effectiveAborted &&
    effectiveState !== 'output-available' &&
    effectiveState !== 'output-error';

  const marker = Icon ? (
    <TimelineIconMarker
      Icon={Icon}
      isLast={isLast}
      isLoading={isLoading}
      aborted={effectiveAborted}
      state={effectiveState}
      isError={effectiveLabel?.isError ?? false}
    />
  ) : (
    <TimelineDot isLast={isLast} />
  );

  return (
    <TimelineItem marker={marker}>
      <div className={cn('min-w-0 flex-1', isLast ? '' : 'pb-3.5')}>
        {children}
      </div>
    </TimelineItem>
  );
}

function TimelineDisclosure({
  label,
  state,
  part,
  defaultOpen = false,
  children,
}: {
  label: ToolLabel;
  state?: ToolUIPart['state'];
  part?: ToolUIPart;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="flex min-w-0 flex-1 flex-col"
    >
      <CollapsibleTrigger className="cursor-pointer">
        <ToolLabelBlock label={label} state={state} part={part} />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export const Timeline = {
  Item: TimelineRow,
  Disclosure: TimelineDisclosure,
};
