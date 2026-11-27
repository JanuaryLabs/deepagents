import { type DynamicToolUIPart, type ToolUIPart, getToolName } from 'ai';

import { Response } from '../elements/Response.tsx';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '../elements/Tool.tsx';
import { useGenaiMessages } from '../i18n/provider.tsx';

export function ToolDebug({ part }: { part: ToolUIPart }) {
  const t = useGenaiMessages();

  return (
    <Tool data-copy-exclude="assistant-snapshot">
      <ToolHeader
        title={t('tool.executing', { tool: getToolName(part) })}
        part={part}
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
  const t = useGenaiMessages();
  return (
    <Tool data-copy-exclude="assistant-snapshot">
      <ToolHeader
        title={t('tool.executing', { tool: part.toolName })}
        part={part}
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
