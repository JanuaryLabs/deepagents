import { Attachment } from '@zukhruf/shadcn';
import type { Citation, ToolUIPart } from 'ai';
import { cn } from 'cn';
import type { Nodes, PhrasingContent, Root } from 'mdast';
import { createContext, use, useMemo } from 'react';
import { defaultRemarkPlugins } from 'streamdown';
import { CONTINUE, SKIP, visit } from 'unist-util-visit';

import { CitationPill } from '../components/CitationPill.tsx';
import {
  type GenAIInteractiveElement,
  InteractiveResponse,
} from '../components/InteractiveResponse.tsx';
import { ToolDebug } from '../components/tool-debug.tsx';
import { useIsAssistantSnapshotRender } from '../copy/assistant-snapshot.tsx';
import { useGenaiMessages } from '../i18n/provider.tsx';
import { RenderPart } from '../renderers/render-part.tsx';
import { useAgent, useAgentStatus } from './agent-context.tsx';
import { citationsInReadingOrder } from './citation-order.ts';
import {
  type CitationSource,
  type UrlCitation,
  citationIndexOf,
  extractSourcesFromMessage,
  urlCitationsOf,
} from './citations.ts';
import {
  type MessagesContextValue,
  useMessageItem,
  useMessagesContext,
} from './trajectory/messages-context.ts';

export const SLIDE_UP_ANIMATED = { animation: 'slideUp' } as const;

type MessageAttachmentPartProps = {
  filename?: string;
  mediaType: string;
  url: string;
};

function ImageFilePart({ filename, url }: { filename?: string; url: string }) {
  const t = useGenaiMessages();
  return (
    <img
      src={url}
      alt={filename ?? t('attachment.image')}
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
  const t = useGenaiMessages();
  const name = filename || t('attachment.untitled');
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
        <strong>{t('attachment.file')}</strong> {name} ({mediaType})
        {url ? (
          <>
            {' '}
            <a href={url} download={filename} className="underline">
              {t('attachment.download')}
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

function placeCitations(text: string, citations: UrlCitation[]): string {
  return citationsInReadingOrder(text, citations)
    .reverse()
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

// A pill is an atomic inline, so the browser may break the line on either side
// of it: the period after it then starts the next line alone, or the pill
// starts a line cut from its word (#6206). As footnote marks are set, the word
// before the pills of one place, the pills and the closing punctuation right
// after them form one group that does not wrap. A group cannot break even where
// overflow-wrap would, so a word longer than GLUED_WORD_LIMIT UTF-16 units stays
// out: 16 of the widest glyphs (CJK, Cyrillic capitals, about 14px each) and
// three pills come to 285px, inside a 320px column's 296px. The group is made
// in the markdown tree, not in the text, so streamdown's text-direction count
// sees no more tag letters.
const CITATION_GROUP_TAG = 'genai-citation-group';
const CLOSING_PUNCTUATION = /^[.,;:!?)\]»،؛؟۔]+/u;
const LAST_WORD = /\S+$/u;
const GLUED_WORD_LIMIT = 16;

interface CitationGroupNode {
  type: 'citationGroup';
  data: { hName: string };
  children: PhrasingContent[];
}

declare module 'mdast' {
  interface PhrasingContentMap {
    citationGroup: CitationGroupNode;
  }

  interface RootContentMap {
    citationGroup: CitationGroupNode;
  }
}

// The inline html nodes normalizeStreamdownChildren makes of one citation tag
// in a sentence: <span><genai-citation citation="n"></genai-citation></span>.
const CITATION_HTML = [
  /^<span>$/,
  new RegExp(`^<${CITATION_TAG}\\s[^>]*>$`),
  new RegExp(`^</${CITATION_TAG}>$`),
  /^<\/span>$/,
];

function isCitationAt(
  children: readonly PhrasingContent[],
  at: number,
): boolean {
  return CITATION_HTML.every((pattern, offset) => {
    const node = children[at + offset];
    return node?.type === 'html' && pattern.test(node.value);
  });
}

// The nodes whose children are sentence text, where a citation tag can sit.
function phrasingChildrenOf(node: Nodes): PhrasingContent[] | undefined {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'tableCell':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'link':
    case 'linkReference':
      return node.children;
    default:
      return undefined;
  }
}

function groupCitationRuns(children: PhrasingContent[]) {
  for (let at = 0; at < children.length; at++) {
    let end = at;
    while (isCitationAt(children, end)) end += CITATION_HTML.length;
    if (end === at) continue;
    const grouped = children.slice(at, end);
    const previous = children[at - 1];
    const word =
      previous?.type === 'text'
        ? LAST_WORD.exec(previous.value)?.[0]
        : undefined;
    if (previous?.type === 'text' && word && word.length <= GLUED_WORD_LIMIT) {
      grouped.unshift({ type: 'text', value: word });
      previous.value = previous.value.slice(0, -word.length);
      if (!previous.value) at--;
    }
    const next = children[end];
    const punctuation =
      next?.type === 'text'
        ? CLOSING_PUNCTUATION.exec(next.value)?.[0]
        : undefined;
    if (next?.type === 'text' && punctuation) {
      grouped.push({ type: 'text', value: punctuation });
      next.value = next.value.slice(punctuation.length);
      if (!next.value) end++;
    }
    // Inside a bare <span>, as the normalizer places an inline element, so
    // MarkdownParagraph keeps the sentence a <p>.
    children.splice(at, end - at, {
      type: 'citationGroup',
      data: { hName: 'span' },
      children: [
        {
          type: 'citationGroup',
          data: { hName: CITATION_GROUP_TAG },
          children: grouped,
        },
      ],
    });
  }
}

function groupCitations() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (node.type === 'citationGroup') return SKIP;
      const children = phrasingChildrenOf(node);
      if (children) groupCitationRuns(children);
      return CONTINUE;
    });
  };
}

const CITATION_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  groupCitations,
];

const CITATION_GROUP_ELEMENT: GenAIInteractiveElement = {
  name: CITATION_GROUP_TAG,
  allowedAttributes: [],
  component: ({ children }) => (
    <span className="whitespace-nowrap">{children}</span>
  ),
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
  const { citation: HostCitation } = useMessagesContext();
  const { message } = useMessageItem();

  const urlCitations = useMemo(() => urlCitationsOf(citations), [citations]);
  const cited = useMemo<TextCitations>(
    () => ({
      citations: urlCitations,
      sources: extractSourcesFromMessage(message),
      HostCitation,
    }),
    [urlCitations, message, HostCitation],
  );
  const hasCitations = urlCitations.length > 0;
  const withCitations = useMemo(
    () =>
      hasCitations
        ? [...(elements ?? []), CITATION_ELEMENT, CITATION_GROUP_ELEMENT]
        : elements,
    [hasCitations, elements],
  );

  return (
    <TextCitationsContext value={cited}>
      <div className={cn('text-sm', className)}>
        <InteractiveResponse
          elements={withCitations}
          remarkPlugins={hasCitations ? CITATION_REMARK_PLUGINS : undefined}
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
