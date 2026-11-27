import type { UIMessage } from 'ai';

import { isRecord, isSyntheticReminderMessage } from '@deepagents/context';

/**
 * The kinds of user messages written for the model only, named as Codex's
 * `ContextualUserFragment::content_kind` names them. A UI never sees them.
 */
export const ModelOnlyContentKind = {
  /** `core/src/context/turn_aborted.rs` */
  turnAborted: 'generic.turn_aborted',
  /** `ext/skills/src/fragments.rs` */
  selectedSkillInstructions: 'skills.selected_skill_instructions',
  /** `core/src/context/inter_agent_message.rs` */
  interAgentMessage: 'multi_agent.inter_agent_message',
} as const;

type ModelOnlyKind =
  (typeof ModelOnlyContentKind)[keyof typeof ModelOnlyContentKind];

const modelOnlyKinds: ReadonlySet<unknown> = new Set(
  Object.values(ModelOnlyContentKind),
);

/** The `metadata.zukhruf` entry that tags a model-only message. */
export function contentKindMetadata(kind: ModelOnlyKind) {
  return { zukhruf: { contentKind: kind } };
}

/** A user message written for the model only: tagged with a model-only kind, or one of context's synthetic reminders. */
export function isModelOnlyMessage(message: UIMessage): boolean {
  if (isSyntheticReminderMessage(message)) return true;
  if (!isRecord(message.metadata)) return false;
  const zukhruf = message.metadata.zukhruf;
  return isRecord(zukhruf) && modelOnlyKinds.has(zukhruf.contentKind);
}
