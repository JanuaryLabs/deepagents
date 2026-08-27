import type { ToolUIPart } from 'ai';

import { cn } from '@deepagents/react-shadcn';

import {
  type GenAIInteractiveElement,
  InteractiveResponse,
} from '../components/InteractiveResponse.tsx';
import { ToolDebug } from '../components/tool-debug.tsx';
import { useIsAssistantSnapshotRender } from '../copy/assistant-snapshot.tsx';
import { RenderPart } from '../renderers/render-part.tsx';
import { useAgent, useAgentStatus } from './agent-context.tsx';

export const SLIDE_UP_ANIMATED = { animation: 'slideUp' } as const;

export function FilePart({
  filename,
  mediaType,
}: {
  filename?: string;
  mediaType: string;
}) {
  return (
    <div className="bg-muted/30 rounded-md border p-3 text-sm">
      <strong>File:</strong> {filename || 'Untitled'} ({mediaType})
    </div>
  );
}

export function AssistantTextPart({
  text,
  components,
  className,
}: {
  text: string;
  components?: GenAIInteractiveElement[];
  className?: string;
}) {
  const { status } = useAgentStatus();
  const isSnapshotRender = useIsAssistantSnapshotRender();

  return (
    <div className={cn('text-sm', className)}>
      <InteractiveResponse
        elements={components}
        animated={SLIDE_UP_ANIMATED}
        isAnimating={!isSnapshotRender && status === 'streaming'}
      >
        {text}
      </InteractiveResponse>
    </div>
  );
}

export function ToolPartContent({ part }: { part: ToolUIPart }) {
  const showDebug = useShowDebug();
  return (
    <>
      {showDebug && <ToolDebug part={part} />}
      <RenderPart part={part} />
    </>
  );
}

export function useShowDebug(): boolean {
  const { debugMode } = useAgent();
  const isSnapshotRender = useIsAssistantSnapshotRender();
  return !!debugMode && !isSnapshotRender;
}
