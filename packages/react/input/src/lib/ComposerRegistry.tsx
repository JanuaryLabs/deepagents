import { Children, Fragment, type ReactNode, isValidElement } from 'react';

import type {
  ComposerItem,
  ComposerItemEntry,
  ComposerPopupTrigger,
  ComposerVisibility,
} from './ComposerTypes.ts';

const TRIGGER_ROLE = Symbol.for('composer.registry.trigger');
const COMMAND_ROLE = Symbol.for('composer.registry.command');
const MENTION_ROLE = Symbol.for('composer.registry.mention');

export type ComposerTriggerProps = {
  trigger: ComposerPopupTrigger;
  children?: ReactNode;
};

export type ComposerCommandProps = Omit<ComposerItem, 'atomic'>;

export type ComposerMentionProps = {
  id: string;
  value: string;
  label: string;
  detail: string;
  icon?: ReactNode;
  payload?: unknown;
  persistsAs?: string;
  visibility?: ComposerVisibility;
};

export function ComposerTrigger(_props: ComposerTriggerProps): null {
  return null;
}
ComposerTrigger.role = TRIGGER_ROLE;

export function ComposerCommand(_props: ComposerCommandProps): null {
  return null;
}
ComposerCommand.role = COMMAND_ROLE;

export function ComposerMention(_props: ComposerMentionProps): null {
  return null;
}
ComposerMention.role = MENTION_ROLE;

export type ComposerRegistry = {
  slashCommands: ComposerItemEntry[];
  mentionCandidates: ComposerItemEntry[];
  commandTriggers: string[];
  mentionTriggers: string[];
  hasLayoutChildren: boolean;
};

export function collectComposerRegistry(children: ReactNode): ComposerRegistry {
  const slashCommands: ComposerItemEntry[] = [];
  const mentionCandidates: ComposerItemEntry[] = [];
  const commandTriggers = new Set<string>();
  const mentionTriggers = new Set<string>();
  let hasLayoutChildren = false;

  const visit = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement(child)) {
        hasLayoutChildren = true;
        continue;
      }
      if (child.type === Fragment) {
        if (isValidElement<{ children?: ReactNode }>(child)) {
          visit(child.props.children);
        }
        continue;
      }
      if (hasRole(child.type, TRIGGER_ROLE)) {
        if (isValidElement<ComposerTriggerProps>(child)) {
          collectTriggerItems(child.props, {
            slashCommands,
            mentionCandidates,
            commandTriggers,
            mentionTriggers,
          });
        }
        continue;
      }
      if (
        hasRole(child.type, COMMAND_ROLE) ||
        hasRole(child.type, MENTION_ROLE)
      ) {
        throw new Error(
          'Composer.Command and Composer.Mention must be placed inside a <Composer.Trigger>.',
        );
      }
      hasLayoutChildren = true;
    }
  };

  visit(children);
  return {
    slashCommands,
    mentionCandidates,
    commandTriggers: [...commandTriggers],
    mentionTriggers: [...mentionTriggers],
    hasLayoutChildren,
  };
}

export function composerRegistrySignature(registry: ComposerRegistry) {
  return JSON.stringify([
    registry.slashCommands.map(withoutIcon),
    registry.mentionCandidates.map(withoutIcon),
    registry.commandTriggers,
    registry.mentionTriggers,
  ]);
}

// An icon is a React element: it does not survive JSON.stringify and carries no
// stable identity to compare, so it stays out of the signature. Nothing about
// how a suggestion matches, inserts, or submits depends on it.
function withoutIcon(item: ComposerItemEntry) {
  const { icon, ...rest } = item;
  return rest;
}

type RegistrySink = {
  slashCommands: ComposerItemEntry[];
  mentionCandidates: ComposerItemEntry[];
  commandTriggers: Set<string>;
  mentionTriggers: Set<string>;
};

function collectTriggerItems(props: ComposerTriggerProps, sink: RegistrySink) {
  const { trigger } = props;
  for (const item of Children.toArray(props.children)) {
    if (!isValidElement(item)) {
      continue;
    }
    if (item.type === Fragment) {
      if (isValidElement<{ children?: ReactNode }>(item)) {
        collectTriggerItems({ trigger, children: item.props.children }, sink);
      }
      continue;
    }
    if (hasRole(item.type, COMMAND_ROLE)) {
      if (sink.mentionTriggers.has(trigger)) {
        throw new Error(
          `Composer.Trigger "${trigger}" already holds mentions; a trigger carries either commands or mentions, not both.`,
        );
      }
      sink.commandTriggers.add(trigger);
      if (isValidElement<ComposerCommandProps>(item)) {
        sink.slashCommands.push({ ...item.props, atomic: false, trigger });
      }
      continue;
    }
    if (hasRole(item.type, MENTION_ROLE)) {
      if (sink.commandTriggers.has(trigger)) {
        throw new Error(
          `Composer.Trigger "${trigger}" already holds commands; a trigger carries either commands or mentions, not both.`,
        );
      }
      sink.mentionTriggers.add(trigger);
      if (isValidElement<ComposerMentionProps>(item)) {
        sink.mentionCandidates.push(toMentionCandidate(item.props, trigger));
      }
      continue;
    }
    throw new Error(
      `<Composer.Trigger trigger="${trigger}"> accepts only <Composer.Command> and <Composer.Mention> children; wrap them in a fragment rather than a component, which the registry cannot see through.`,
    );
  }
}

function toMentionCandidate(
  props: ComposerMentionProps,
  trigger: string,
): ComposerItemEntry {
  return {
    id: props.id,
    trigger,
    value: props.value,
    label: props.label,
    detail: props.detail,
    atomic: true,
    icon: props.icon,
    payload: props.payload,
    persistsAs: props.persistsAs,
    visibility: props.visibility,
  };
}

function hasRole(type: unknown, role: symbol) {
  return typeof type === 'function' && 'role' in type && type.role === role;
}
