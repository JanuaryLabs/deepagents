import { type ToolUIPart, getToolName } from 'ai';
import { CircleHelp } from 'lucide-react';
import { useId, useState } from 'react';

import {
  type ComponentTool,
  ToolError,
  useAgentMessages,
} from '@deepagents/react-genai';
import { cn } from '@deepagents/react-shadcn';

import { SubmittedOutputView } from './clarification/primitives.tsx';
import { inputSchema, outputSchema } from './clarification/schemas.ts';
import { ClarificationWizard } from './clarification/wizard.tsx';

function AskUserQuestion({ part }: { part: ToolUIPart }) {
  const agent = useAgentMessages();
  const [submitted, setSubmitted] = useState(false);
  const fieldId = useId();

  if (part.state === 'output-available') {
    const output = outputSchema.safeParse(part.output);
    return output.success ? (
      <div
        className={cn(
          'border-border/60 bg-muted/20 mb-2 rounded-lg border border-dashed',
        )}
      >
        <SubmittedOutputView answers={output.data.answers} />
      </div>
    ) : null;
  }

  if (part.state !== 'input-available') return null;
  const parsed = inputSchema.safeParse(part.input);
  if (!parsed.success) {
    return (
      <ToolError
        error={parsed.error}
        title="Failed to render clarification"
        detail={JSON.stringify(part.input, null, 2)}
        detailLabel="View input"
        part={part}
      />
    );
  }

  return (
    <div
      className={cn(
        'border-border/60 bg-muted/20 rounded-lg border border-dashed',
        'animate-in fade-in-0 duration-200',
      )}
    >
      <ClarificationWizard.Root
        questions={parsed.data.questions}
        onSubmit={async (answers) => {
          await agent.addToolOutput({
            toolCallId: part.toolCallId,
            tool: getToolName(part),
            output: { answers },
            state: 'output-available',
          });
          setSubmitted(true);
        }}
        disabled={submitted}
        fieldId={fieldId}
      >
        <ClarificationWizard.Submitted />
        <ClarificationWizard.Header />
        <ClarificationWizard.Content className="space-y-2 px-3 pb-2">
          <ClarificationWizard.Field />
          <ClarificationWizard.Error />
        </ClarificationWizard.Content>
        <ClarificationWizard.Navigation />
      </ClarificationWizard.Root>
    </div>
  );
}

export const askUserQuestionTool = {
  component: AskUserQuestion,
  label: (part) => {
    const parsed =
      part.state === 'input-available' || part.state === 'output-available'
        ? inputSchema.safeParse(part.input)
        : undefined;
    const firstQuestion = parsed?.success
      ? parsed.data.questions[0]
      : undefined;
    return {
      name: 'AskUserQuestion',
      icon: CircleHelp,
      args: firstQuestion
        ? { question: firstQuestion.header ?? firstQuestion.question }
        : undefined,
    };
  },
  requiresUserInput: true,
  static: false,
  inputSchema,
  description: `Tool to collect information from the user via a multi-step wizard. Use when you need to clarify requirements, gather preferences, or resolve ambiguity before proceeding.

Each question MUST have a "type" field set to "choice" for selection from predefined options (single or multiple).

IMPORTANT: NEVER include an "Other" option in your options array — the UI always renders one automatically with an inline text input.

Example:
{"questions":[{"type":"choice","question":"Which timeframe?","header":"Timeframe","multiSelect":false,"options":[{"label":"Last 30 days"},{"label":"Last quarter"}]}]}`,
} satisfies ComponentTool<typeof inputSchema>;
