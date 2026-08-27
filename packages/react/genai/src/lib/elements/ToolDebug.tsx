import { type DynamicToolUIPart, type ToolUIPart } from 'ai';
import { useState } from 'react';

import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from './Tool.tsx';

export function ToolDebug({ part }: { part: ToolUIPart }) {
  const [open, setOpen] = useState(false);

  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader state={part.state} type={part.type} />
      <ToolContent>
        <ToolInput input={part.input} />

        <ToolOutput
          output={
            part.output
            // <Response className="break-all">{part.output as any}</Response>
          }
          errorText={part.errorText}
        />
      </ToolContent>
    </Tool>
  );
}
export function DynamicToolDebug({ part }: { part: DynamicToolUIPart }) {
  const [open, setOpen] = useState(false);

  return (
    <Tool open={open} onOpenChange={setOpen}>
      {}
      <ToolHeader state={part.state} type={part.type as 'tool-dynamic'} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={
            part.output
            // <Response className="break-all">{part.output as any}</Response>
          }
          errorText={part.errorText}
        />
      </ToolContent>
    </Tool>
  );
}
