import type { ToolUIPart } from 'ai';
import { isStaticToolUIPart } from 'ai';
import { Activity, type PropsWithChildren, useMemo } from 'react';

import { cn } from '@deepagents/react-shadcn';

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

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deps are correct; compiler can't verify registry shape
  return useMemo(() => {
    if (!registry) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'assistant') continue;

      for (const part of message.parts) {
        if (!isStaticToolUIPart(part)) continue;
        if (part.state !== 'input-available') continue;

        const toolKey = part.type.replace('tool-', '');
        const entry = registry[toolKey];
        if (!entry || entry.static !== false) continue;
        if (!entry.needsApproval) continue;

        return { part, entry };
      }
      break;
    }

    return null;
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
