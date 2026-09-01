import { type ToolUIPart } from 'ai';
import { Loader } from 'lucide-react';

import { Button } from '@deepagents/react-shadcn';

import {
  useAgent,
  useAgentMessages,
} from '../chat/agent-context.tsx';

function ToolApproval({ part }: { part: ToolUIPart }) {
  const { addToolApprovalResponse } = useAgentMessages();
  if (part.state !== 'approval-requested') return null;

  const name = part.title ?? part.type.slice('tool-'.length);

  return (
    <div
      aria-label={`${name} approval`}
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-3"
      data-copy-exclude="assistant-snapshot"
      role="group"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{name}</p>
        {part.approval.requestReason && (
          <p className="text-muted-foreground text-sm">
            {part.approval.requestReason}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="destructive"
          onClick={() =>
            void addToolApprovalResponse({
              id: part.approval.id,
              approved: false,
            })
          }
        >
          Deny
        </Button>
        <Button
          type="button"
          onClick={() =>
            void addToolApprovalResponse({
              id: part.approval.id,
              approved: true,
            })
          }
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

export function RenderPart({ part }: { part: ToolUIPart }) {
  const { registry } = useAgent();

  if (!part.input) {
    return <Loader className="size-4 animate-spin" />;
  }

  const approval = <ToolApproval part={part} />;

  if (!registry) return approval;

  const customRenderer = registry[part.type.replace('tool-', '')];
  if (customRenderer) {
    const Renderer = customRenderer.component;
    return (
      <div className="space-y-2">
        {registry.progress && <registry.progress.component part={part} />}
        <Renderer part={part} />
        {approval}
      </div>
    );
  } else {
    return (
      <>
        {registry.progress && <registry.progress.component part={part} />}
        {approval}
      </>
    );
  }
}
