import type { ClipboardEvent, ReactNode } from 'react';

import {
  type PersistedPromptToken,
  tokenizePersistedPrompt,
} from '../persisted-prompt.ts';
import type { ComposerPastedTextLabel } from './ComposerTypes.ts';
import { reconstructPersistedPromptSelection } from './persisted-prompt-selection.ts';

/** A collapsed paste's `[Pasted Content N chars]` placeholder, with the `#K` a second paste of the same length takes. */
const PASTE_PLACEHOLDER = /\[Pasted Content (\d+) chars\](?: #\d+)?/g;

export function PersistedPromptText({
  text,
  skillIcon,
  pastedTextLabel,
}: {
  text: string;
  /** Drawn before each skill reference's name. */
  skillIcon: ReactNode;
  /** Names a collapsed paste in the host's words, as the composer's editor does. */
  pastedTextLabel: ComposerPastedTextLabel;
}) {
  const tokens = tokenizePersistedPrompt(text);
  return (
    <span onCopy={copyPersistedSelection}>
      {tokens.map((token) =>
        renderPromptToken(token, skillIcon, pastedTextLabel),
      )}
    </span>
  );
}

function renderPromptToken(
  token: PersistedPromptToken,
  skillIcon: ReactNode,
  pastedTextLabel: ComposerPastedTextLabel,
): ReactNode {
  switch (token.kind) {
    case 'text':
      return renderPlainText(token.value, token.start, pastedTextLabel);
    case 'inline-code':
      return (
        <code
          key={token.start}
          data-persisted-source={token.source}
          className="bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]"
        >
          {token.value}
        </code>
      );
    case 'code-block':
      return (
        <span
          key={token.start}
          data-persisted-source={token.source}
          className="bg-muted my-2 block overflow-x-auto rounded-md px-3 py-2"
        >
          <code className="font-mono text-[0.9em]">{token.value}</code>
        </span>
      );
    case 'skill-link':
      return (
        <SkillReference
          key={token.start}
          name={token.name}
          source={token.source}
          skillId={token.skillId}
          title={token.href}
          icon={skillIcon}
        />
      );
    case 'standalone-skill':
      return (
        <SkillReference
          key={token.start}
          name={token.name}
          source={token.source}
          icon={skillIcon}
        />
      );
    case 'mention':
      return (
        <span
          key={token.start}
          data-token="mention"
          data-persisted-source={token.source}
          className="bg-foreground/10 rounded-sm px-0.5 font-medium"
        >
          {token.label}
        </span>
      );
    case 'link':
      return /^(?:https?:|mailto:)/.test(token.href) ? (
        <a
          key={token.start}
          href={token.href}
          data-persisted-source={token.source}
          className="text-primary underline underline-offset-2"
          target="_blank"
          rel="noreferrer"
        >
          {token.label}
        </a>
      ) : (
        token.source
      );
  }
}

function SkillReference({
  name,
  source,
  skillId,
  title,
  icon,
}: {
  name: string;
  source: string;
  skillId?: string;
  title?: string;
  icon: ReactNode;
}) {
  return (
    <span
      data-skill-id={skillId}
      data-skill-name={skillId ? undefined : name}
      data-persisted-source={source}
      title={title}
      className="text-primary inline-flex items-baseline gap-1"
    >
      {icon}
      <span>{name}</span>
    </span>
  );
}

function copyPersistedSelection(event: ClipboardEvent<HTMLSpanElement>) {
  const source = reconstructPersistedPromptSelection(
    event.currentTarget,
    window.getSelection(),
  );
  if (source === null) return;

  event.clipboardData.setData('text/plain', source);
  event.preventDefault();
}

function renderPlainText(
  text: string,
  start: number,
  pastedTextLabel: ComposerPastedTextLabel,
): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PASTE_PLACEHOLDER)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(
      <span
        key={start + match.index}
        data-token="paste"
        data-persisted-source={match[0]}
      >
        {pastedTextLabel({ chars: Number(match[1]) })}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
