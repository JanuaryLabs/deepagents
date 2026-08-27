import { type ToolUIPart, getToolName } from 'ai';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ZodError } from 'zod';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@deepagents/react-shadcn';

import { useAgentMessages } from '../chat/agent-context.tsx';

export interface ToolErrorProps {
  title?: string;
  detail?: string;
  detailLabel?: string;
  part: ToolUIPart;
  error: ZodError;
}

export function ToolError({
  title = 'Failed to render tool',
  detail,
  detailLabel = 'View details',
  part,
  error,
}: ToolErrorProps) {
  const agent = useAgentMessages();
  const errorMessage = error.issues
    .map((e) => `${e.path.join('.')}: ${e.message}`)
    .join('\n');
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader>
        <CardTitle className="text-destructive flex items-center gap-2">
          <AlertCircle className="size-5" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>

        {detail && (
          <details className="text-sm">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
              {detailLabel}
            </summary>
            <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs">
              <code>{detail}</code>
            </pre>
          </details>
        )}
      </CardContent>
      {
        <CardFooter>
          <Button
            variant="outline"
            onClick={() => {
              const retryPrompt = [
                `The model tried to call the tool "${getToolName(part)}"` +
                  ` with the following inputs:`,
                JSON.stringify(part.input),
                'Please fix the inputs.',
              ];

              agent.addToolOutput({
                toolCallId: part.toolCallId,
                tool: getToolName(part),
                output: retryPrompt,
                state: 'output-available',
              });
            }}
            className="gap-2"
          >
            <RefreshCw className="size-4" />
            Ask AI to fix this
          </Button>
        </CardFooter>
      }
    </Card>
  );
}
