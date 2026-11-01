import type { ToolUIPart } from 'ai';
import { isStaticToolUIPart } from 'ai';
import { cn } from 'cn';
import { Activity, type PropsWithChildren, useMemo } from 'react';

import { useAgent, useAgentMessages } from '../chat/agent-context.tsx';
import type { ComponentTool } from '../tools/registry.ts';

export type ActivePendingTool = {
  part: ToolUIPart;
  entry: ComponentTool;
};

export function useActivePendingToolInput(): ActivePendingTool | null {
  const { registry } = useAgent();
  const agent = useAgentMessages();
  const messages = agent.messages;

  return useMemo(() => {
    if (!registry) return null;

    const message = messages.findLast(({ role }) => role === 'assistant');
    if (!message) return null;

    const pending = message.parts.flatMap((part) => {
      if (!isStaticToolUIPart(part)) return [];
      if (part.state !== 'input-available') return [];

      const toolKey = part.type.replace('tool-', '');
      const entry = registry[toolKey];
      if (!entry || entry.static !== false) return [];
      if (!entry.requiresUserInput) return [];

      return [{ part, entry }];
    });

    return pending.at(0) ?? null;
  }, [messages, registry]);
}

export function PendingToolInput({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  const activeTool = useActivePendingToolInput();
  const Renderer = activeTool?.entry.component;

  return (
    <>
      <Activity mode={activeTool ? 'hidden' : 'visible'}>{children}</Activity>
      {activeTool && Renderer ? (
        <div className={cn('sticky bottom-0 mt-auto', className)}>
          <Renderer key={activeTool.part.toolCallId} part={activeTool.part} />
        </div>
      ) : null}
    </>
  );
}
