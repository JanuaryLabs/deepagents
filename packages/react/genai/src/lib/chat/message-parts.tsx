import type { ToolUIPart } from 'ai';

import { Attachment, cn } from '@deepagents/react-shadcn';

import {
  type GenAIInteractiveElement,
  InteractiveResponse,
} from '../components/InteractiveResponse.tsx';
import { ToolDebug } from '../components/tool-debug.tsx';
import { useIsAssistantSnapshotRender } from '../copy/assistant-snapshot.tsx';
import { RenderPart } from '../renderers/render-part.tsx';
import { useAgent, useAgentStatus } from './agent-context.tsx';

export const SLIDE_UP_ANIMATED = { animation: 'slideUp' } as const;

type MessageAttachmentPartProps = {
  filename?: string;
  mediaType: string;
  url: string;
};

function ImageFilePart({ filename, url }: { filename?: string; url: string }) {
  return (
    <img
      src={url}
      alt={filename ?? 'Attached image'}
      className="max-h-64 rounded-md border object-contain"
    />
  );
}

function FileAttachmentPart({
  filename,
  mediaType,
  url,
}: {
  filename?: string;
  mediaType: string;
  url?: string;
}) {
  const name = filename || 'Untitled';
  const player = url?.startsWith('data:') ? null : url &&
    mediaType.startsWith('video/') ? (
    <video
      controls
      playsInline
      preload="metadata"
      src={url}
      aria-label={name}
      className="max-h-96 w-full rounded-md bg-black"
    />
  ) : url && mediaType.startsWith('audio/') ? (
    <audio
      controls
      preload="metadata"
      src={url}
      aria-label={name}
      className="w-full"
    />
  ) : null;
  return (
    <Attachment className="bg-muted/30 block w-full rounded-md p-3 text-sm text-inherit">
      {player}
      <div className={player ? 'mt-2' : undefined}>
        <strong>File:</strong> {name} ({mediaType})
        {url ? (
          <>
            {' '}
            <a href={url} download={filename} className="underline">
              Download
            </a>
          </>
        ) : null}
      </div>
    </Attachment>
  );
}

export function MessageAttachmentPart({
  filename,
  mediaType,
  url,
}: MessageAttachmentPartProps) {
  return mediaType.startsWith('image/') ? (
    <ImageFilePart filename={filename} url={url} />
  ) : (
    <FileAttachmentPart filename={filename} mediaType={mediaType} url={url} />
  );
}

export function AssistantTextPart({
  text,
  elements,
  className,
}: {
  text: string;
  elements?: GenAIInteractiveElement[];
  className?: string;
}) {
  const { status } = useAgentStatus();
  const isSnapshotRender = useIsAssistantSnapshotRender();

  return (
    <div className={cn('text-sm', className)}>
      <InteractiveResponse
        elements={elements}
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
