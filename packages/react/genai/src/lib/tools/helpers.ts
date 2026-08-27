import type { ToolUIPart, UIMessage } from 'ai';
import { isToolUIPart } from 'ai';

import type { ComponentRegistry } from './registry.ts';

/**
 * A subagent call is identified by the `toolMetadata` the backend attaches to
 * the tool definition, never by tool name — so every tool built by the subagent
 * factory renders as a chip without the UI enumerating them.
 */
export function isSubagentPart(part: UIMessage['parts'][number]) {
  return isToolUIPart(part) && part.toolMetadata?.kind === 'subagent';
}

export function subagentDisplayName(part: ToolUIPart) {
  const name = part.toolMetadata?.displayName;
  return typeof name === 'string' ? name : 'Subagent';
}

export function resolveToolEntry(
  part: Pick<UIMessage['parts'][number], 'type'>,
  registry: ComponentRegistry | undefined,
) {
  const toolKey = part.type.replace('tool-', '');
  const toolEntry = registry?.[toolKey];
  return { toolKey, toolEntry };
}

export function isActiveApprovalTool(
  toolEntry: ComponentRegistry[string] | undefined,
  state: ToolUIPart['state'] | undefined,
): boolean {
  return (
    toolEntry?.static === false &&
    !!toolEntry?.needsApproval &&
    state === 'input-available'
  );
}
