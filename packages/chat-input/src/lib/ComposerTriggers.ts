import escapeRegExp from 'lodash-es/escapeRegExp.js';

export function triggerAlternation(triggers: string[]) {
  return triggers.map(escapeRegExp).join('|');
}

export function commandTokenPattern(commandTriggers: string[]) {
  return `(?:${triggerAlternation(commandTriggers)})[A-Za-z0-9_:-]+`;
}

export function mentionTokenPattern(mentionTriggers: string[]) {
  return `(?:${triggerAlternation(mentionTriggers)})[^\\s]+`;
}

export function tokenScanPattern(
  commandTriggers: string[],
  mentionTriggers: string[],
) {
  const parts: string[] = [];
  if (mentionTriggers.length > 0) {
    parts.push(mentionTokenPattern(mentionTriggers));
  }
  if (commandTriggers.length > 0) {
    parts.push(commandTokenPattern(commandTriggers));
  }
  return parts.length > 0 ? new RegExp(parts.join('|'), 'g') : null;
}

export function startsWithTrigger(text: string, triggers: string[]) {
  return triggers.some((trigger) => text.startsWith(trigger));
}

export function triggerOf(text: string, triggers: string[]) {
  return triggers.find((trigger) => text.startsWith(trigger));
}

export function itemToken(item: { trigger: string; value: string }) {
  return `${item.trigger}${item.value}`;
}
