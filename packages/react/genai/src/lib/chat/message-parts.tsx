import { Attachment } from '@zukhruf/shadcn';
import type { Citation, ToolUIPart } from 'ai';
import { cn } from 'cn';
import { createContext, use, useMemo } from 'react';

import { CitationPill } from '../components/CitationPill.tsx';
import {
  type GenAIInteractiveElement,
  InteractiveResponse,
} from '../components/InteractiveResponse.tsx';
import { ToolDebug } from '../components/tool-debug.tsx';
import { useIsAssistantSnapshotRender } from '../copy/assistant-snapshot.tsx';
import { RenderPart } from '../renderers/render-part.tsx';
import { useAgent, useAgentStatus } from './agent-context.tsx';
import {
  type CitationSource,
  type UrlCitation,
  citationIndexOf,
  extractSourcesFromMessages,
  urlCitationsOf,
} from './citations.ts';
import {
  type MessagesContextValue,
  useMessagesContext,
} from './trajectory/messages-context.ts';

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
    >
      {/* The user's own attachment has no caption source; the empty track
          satisfies jsx-a11y-x/media-has-caption. */}
      <track kind="captions" />
    </video>
  ) : url && mediaType.startsWith('audio/') ? (
    <audio
      controls
      preload="metadata"
      src={url}
      aria-label={name}
      className="w-full"
    >
      <track kind="captions" />
    </audio>
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
  return mediaType.split('/')[0] === 'image' ? (
    <ImageFilePart filename={filename} url={url} />
  ) : (
    <FileAttachmentPart filename={filename} mediaType={mediaType} url={url} />
  );
}

// The tag a text citation takes in the markdown, so it renders inline in its
// sentence through the same element path as a host's elements.
const CITATION_TAG = 'genai-citation';

// Places each citation after the text it supports, or at the end when the
// provider gives no offset (Anthropic sends none).
function placeCitations(text: string, citations: Citation[]): string {
  return citations
    .map((citation, order) => ({ at: citation.endIndex ?? text.length, order }))
    .sort((a, b) => b.at - a.at || b.order - a.order)
    .reduce(
      (marked, { at, order }) =>
        `${marked.slice(0, at)}<${CITATION_TAG} citation="${order}" />${marked.slice(at)}`,
      text,
    );
}

type TextCitations = {
  citations: UrlCitation[];
  sources: CitationSource[];
  HostCitation: MessagesContextValue['citation'];
};

// The citations of the text part being rendered, for the citation tags inside it.
const TextCitationsContext = createContext<TextCitations | null>(null);

function CitationAt(props: Record<string, unknown>) {
  const cited = use(TextCitationsContext);
  const citation = cited?.citations[Number(props.citation)];
  if (!cited || !citation) return null;
  const index = citationIndexOf(cited.sources, citation.source.url);
  if (index === null) return null;
  if (cited.HostCitation)
    return <cited.HostCitation citation={citation} index={index} />;
  return (
    <CitationPill
      source={{ url: citation.source.url, title: citation.source.title }}
      index={index}
    >
      {citation.citedText ? (
        <blockquote dir="auto">{citation.citedText}</blockquote>
      ) : null}
    </CitationPill>
  );
}

const CITATION_ELEMENT: GenAIInteractiveElement = {
  name: CITATION_TAG,
  allowedAttributes: ['citation'],
  component: CitationAt,
};

export function AssistantTextPart({
  text,
  citations,
  elements,
  className,
}: {
  text: string;
  citations?: Citation[];
  elements?: GenAIInteractiveElement[];
  className?: string;
}) {
  const { status } = useAgentStatus();
  const isSnapshotRender = useIsAssistantSnapshotRender();
  const { messages, citation: HostCitation } = useMessagesContext();

  const urlCitations = useMemo(() => urlCitationsOf(citations), [citations]);
  const cited = useMemo<TextCitations>(
    () => ({
      citations: urlCitations,
      sources: extractSourcesFromMessages(messages),
      HostCitation,
    }),
    [urlCitations, messages, HostCitation],
  );
  const hasCitations = urlCitations.length > 0;
  const withCitations = useMemo(
    () => (hasCitations ? [...(elements ?? []), CITATION_ELEMENT] : elements),
    [hasCitations, elements],
  );

  return (
    <TextCitationsContext value={cited}>
      <div className={cn('text-sm', className)}>
        <InteractiveResponse
          elements={withCitations}
          animated={SLIDE_UP_ANIMATED}
          isAnimating={!isSnapshotRender && status === 'streaming'}
        >
          {hasCitations ? placeCitations(text, urlCitations) : text}
        </InteractiveResponse>
      </div>
    </TextCitationsContext>
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
