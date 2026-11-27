import type { ClipboardEvent, ReactNode } from 'react';

import {
  type PersistedPromptToken,
  tokenizePersistedPrompt,
} from '../persisted-prompt.ts';
import { reconstructPersistedPromptSelection } from './persisted-prompt-selection.ts';

export function PersistedPromptText({
  text,
  skillIcon,
}: {
  text: string;
  /** Drawn before each skill reference's name. */
  skillIcon: ReactNode;
}) {
  const tokens = tokenizePersistedPrompt(text);
  return (
    <span onCopy={copyPersistedSelection}>
      {tokens.map((token) => renderPromptToken(token, skillIcon))}
    </span>
  );
}

function renderPromptToken(
  token: PersistedPromptToken,
  skillIcon: ReactNode,
): ReactNode {
  switch (token.kind) {
    case 'text':
      return token.value;
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
