type PersistedPromptTokenBase = {
  source: string;
  start: number;
  end: number;
};

export type PersistedPromptTextToken = PersistedPromptTokenBase & {
  kind: 'text';
  value: string;
};

export type PersistedPromptInlineCodeToken = PersistedPromptTokenBase & {
  kind: 'inline-code';
  value: string;
};

export type PersistedPromptCodeBlockToken = PersistedPromptTokenBase & {
  kind: 'code-block';
  language: string;
  value: string;
};

export type PersistedPromptLinkToken = PersistedPromptTokenBase & {
  kind: 'link';
  label: string;
  href: string;
};

export type PersistedPromptSkillLinkToken = PersistedPromptTokenBase & {
  kind: 'skill-link';
  label: string;
  href: string;
  name: string;
  skillId: string;
};

export type PersistedPromptStandaloneSkillToken = PersistedPromptTokenBase & {
  kind: 'standalone-skill';
  name: string;
};

export type PersistedPromptMentionToken = PersistedPromptTokenBase & {
  kind: 'mention';
  label: string;
  href: string;
  name: string;
};

export type PersistedPromptToken =
  | PersistedPromptTextToken
  | PersistedPromptInlineCodeToken
  | PersistedPromptCodeBlockToken
  | PersistedPromptLinkToken
  | PersistedPromptSkillLinkToken
  | PersistedPromptStandaloneSkillToken
  | PersistedPromptMentionToken;

type PromptLink = {
  label: string;
  href: string;
  start: number;
  end: number;
};

const CODE_PATTERN = /```([^\r\n`]*)\r?\n?([\s\S]*?)```|`([^`\r\n]+)`/g;
const STANDALONE_SKILL_PATTERN = /\$\[[^\]\r\n]+\]|\$[A-Za-z0-9][\w.-]*/g;
const SKILL_HREF_PREFIX = 'skill://';
const MENTION_HREF_PREFIX = 'mention://';

export function serializePersistedPromptLink(label: string, href: string) {
  return `[${escapeLinkPart(label, '[]')}](${escapeLinkPart(href, '()')})`;
}

export function serializeSkillPromptLink(name: string, skillId: string) {
  return serializePersistedPromptLink(
    `$${name}`,
    `${SKILL_HREF_PREFIX}${skillId}`,
  );
}

export function serializeMentionPromptLink(name: string) {
  return serializePersistedPromptLink(
    `@${name}`,
    `${MENTION_HREF_PREFIX}${name}`,
  );
}

export function tokenizePersistedPrompt(text: string): PersistedPromptToken[] {
  const tokens: PersistedPromptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push(...tokenizePromptText(text.slice(cursor, start), cursor));
    }

    const source = match[0];
    const end = start + source.length;
    const codeBlockValue = match[2];
    if (codeBlockValue !== undefined) {
      tokens.push({
        kind: 'code-block',
        source,
        start,
        end,
        language: match[1] ?? '',
        value: codeBlockValue,
      });
    } else {
      tokens.push({
        kind: 'inline-code',
        source,
        start,
        end,
        value: match[3] ?? '',
      });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    tokens.push(...tokenizePromptText(text.slice(cursor), cursor));
  }
  return tokens;
}

function tokenizePromptText(text: string, sourceOffset: number) {
  const tokens: PersistedPromptToken[] = [];
  const links = parsePromptLinks(text);
  let cursor = 0;

  for (const link of links) {
    if (link.start > cursor) {
      tokens.push(
        ...tokenizeStandaloneSkills(
          text.slice(cursor, link.start),
          sourceOffset + cursor,
        ),
      );
    }
    tokens.push(promptLinkToken(link, text, sourceOffset));
    cursor = link.end;
  }

  if (cursor < text.length) {
    tokens.push(
      ...tokenizeStandaloneSkills(text.slice(cursor), sourceOffset + cursor),
    );
  }
  return tokens;
}

function promptLinkToken(
  link: PromptLink,
  text: string,
  sourceOffset: number,
):
  | PersistedPromptLinkToken
  | PersistedPromptSkillLinkToken
  | PersistedPromptMentionToken {
  const start = sourceOffset + link.start;
  const end = sourceOffset + link.end;
  const source = text.slice(link.start, link.end);
  if (link.href.startsWith(MENTION_HREF_PREFIX)) {
    const name = link.href.slice(MENTION_HREF_PREFIX.length);
    if (name) {
      return {
        kind: 'mention',
        source,
        start,
        end,
        label: link.label,
        href: link.href,
        name,
      };
    }
  }
  if (link.label.startsWith('$') && link.href.startsWith(SKILL_HREF_PREFIX)) {
    const name = link.label.slice(1);
    const skillId = link.href.slice(SKILL_HREF_PREFIX.length);
    if (name && skillId) {
      return {
        kind: 'skill-link',
        source,
        start,
        end,
        label: link.label,
        href: link.href,
        name,
        skillId,
      };
    }
  }
  return {
    kind: 'link',
    source,
    start,
    end,
    label: link.label,
    href: link.href,
  };
}

function tokenizeStandaloneSkills(text: string, sourceOffset: number) {
  const tokens: PersistedPromptToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(STANDALONE_SKILL_PATTERN)) {
    const start = match.index;
    const previous = text[start - 1];
    if (previous && /[\w$]/.test(previous)) continue;

    if (start > cursor) {
      tokens.push(textToken(text.slice(cursor, start), sourceOffset + cursor));
    }
    const source = match[0];
    const tokenStart = sourceOffset + start;
    tokens.push({
      kind: 'standalone-skill',
      source,
      start: tokenStart,
      end: tokenStart + source.length,
      name: source.startsWith('$[') ? source.slice(2, -1) : source.slice(1),
    });
    cursor = start + source.length;
  }

  if (cursor < text.length) {
    tokens.push(textToken(text.slice(cursor), sourceOffset + cursor));
  }
  return tokens;
}

function textToken(source: string, start: number): PersistedPromptTextToken {
  return {
    kind: 'text',
    source,
    start,
    end: start + source.length,
    value: source,
  };
}

function parsePromptLinks(text: string): PromptLink[] {
  const links: PromptLink[] = [];

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '[') continue;

    const label = readBracketedPart(text, start + 1, ']');
    if (!label || text[label.end + 1] !== '(') continue;

    const destination = readLinkDestination(text, label.end + 2);
    if (!destination) continue;

    links.push({
      label: label.value,
      href: destination.value,
      start,
      end: destination.end + 1,
    });
    start = destination.end;
  }

  return links;
}

function escapeLinkPart(value: string, delimiters: string) {
  let escaped = '';
  for (const character of value) {
    escaped +=
      character === '\\' || delimiters.includes(character)
        ? `\\${character}`
        : character;
  }
  return escaped;
}

function readBracketedPart(text: string, start: number, closing: string) {
  let value = '';
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      value += text[index + 1];
      index += 1;
      continue;
    }
    if (character === closing) {
      return { value, end: index };
    }
    value += character;
  }
  return null;
}

function readLinkDestination(text: string, start: number) {
  let value = '';
  let nestedParentheses = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      value += text[index + 1];
      index += 1;
      continue;
    }
    if (character === '(') {
      nestedParentheses += 1;
      value += character;
      continue;
    }
    if (character === ')') {
      if (nestedParentheses === 0) {
        return { value, end: index };
      }
      nestedParentheses -= 1;
      value += character;
      continue;
    }
    value += character;
  }
  return null;
}
