import type { ToolUIPart } from 'ai';
import { cn } from 'cn';
import type { ReactNode } from 'react';

import { useIsAssistantSnapshotRender } from '../../copy/assistant-snapshot.tsx';
import type { ToolLabel } from '../../tools/registry.ts';

function isToolRunning(state?: ToolUIPart['state']) {
  return !!state && state !== 'output-available';
}

function useToolActionsVisible({
  label,
  part,
  state,
}: {
  label: ToolLabel;
  part?: ToolUIPart;
  state?: ToolUIPart['state'];
}) {
  const isSnapshotRender = useIsAssistantSnapshotRender();
  return (
    !isSnapshotRender && !!label.actions && !!part && !isToolRunning(state)
  );
}

/**
 * One `name: "value"` pair inside a tool signature. Hosts render their own
 * leading args as children of Segment.ToolDisclosure — a label builder is a
 * pure function, so anything needing a hook (resolving a data-source id to a
 * name) can only be assembled here, in render.
 */
export function ToolArg({
  name,
  value,
}: {
  name: string;
  value: string | undefined;
}) {
  return (
    <span data-slot="tool-arg">
      {name}: &quot;{value}&quot;
    </span>
  );
}

export function ToolLabelBlock({
  label,
  state,
  part,
  children,
}: {
  label: ToolLabel;
  state?: ToolUIPart['state'];
  part?: ToolUIPart;
  /** Leading call args (`ToolArg`); a sentence label draws none. */
  children?: ReactNode;
}) {
  const Actions = label.actions;
  const showActions = useToolActionsVisible({ label, part, state });
  const isSentence = label.kind === 'sentence';

  return (
    <span className="mb-2 flex flex-col gap-1">
      <span className="flex items-start justify-between gap-2">
        {isSentence ? (
          <span
            dir="auto"
            className="text-muted-foreground min-w-0 truncate text-start text-xs"
          >
            {label.text}
          </span>
        ) : (
          /* Separating args in CSS rather than by index lets a host arg
             render null without leaving a stray comma behind. */
          <span className="text-muted-foreground min-w-0 truncate font-mono text-xs [&>[data-slot=tool-arg]+[data-slot=tool-arg]]:before:mr-1 [&>[data-slot=tool-arg]+[data-slot=tool-arg]]:before:content-[',']">
            {label.name}({children}
            {label.args
              ? Object.entries(label.args).map(([key, value]) => (
                  <ToolArg key={key} name={key} value={value} />
                ))
              : '...'}
            )
          </span>
        )}
        {showActions && Actions && part && (
          <span className="shrink-0">
            <Actions part={part} />
          </span>
        )}
      </span>
      {label.detail && (
        <span
          dir={isSentence ? 'auto' : undefined}
          className={cn(
            'line-clamp-3 text-start leading-relaxed whitespace-pre-wrap',
            isSentence ? 'text-xs' : 'font-mono text-[10px]',
            label.isError ? 'text-destructive/80' : 'text-muted-foreground',
          )}
        >
          {label.detail}
        </span>
      )}
    </span>
  );
}
