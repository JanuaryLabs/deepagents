import { type DynamicToolUIPart, type ToolUIPart, getToolName } from 'ai';

import { Response } from '../elements/Response.tsx';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '../elements/Tool.tsx';

export function ToolDebug({ part }: { part: ToolUIPart }) {
  const toolName = getToolName(part);

  return (
    <Tool data-copy-exclude="assistant-snapshot">
      <ToolHeader
        title={`Executing ${toolName}`}
        state={part.state}
        type={part.type}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={
            <Response className="break-all">
              {typeof part.output === 'string'
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </Response>
          }
          errorText={part.errorText}
        />
      </ToolContent>
    </Tool>
  );
}
export function DynamicToolDebug({ part }: { part: DynamicToolUIPart }) {
  return (
    <Tool data-copy-exclude="assistant-snapshot">
      <ToolHeader
        title={`Executing ${part.toolName}`}
        state={part.state}

        type={part.type as 'tool-dynamic'}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={
            <Response className="break-all">
              {typeof part.output === 'string'
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </Response>
          }
          errorText={part.errorText}
        />
      </ToolContent>
    </Tool>
  );
}
