import { type LanguageModelV3 } from '@ai-sdk/provider';
import {
  NoSuchToolError,
  Output,
  type ToolCallRepairFunction,
  type ToolSet,
  generateText,
} from 'ai';
import chalk from 'chalk';

export function createRepairToolCall(
  model: LanguageModelV3,
): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, inputSchema, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null;
    }

    console.log(
      `Debug: ${chalk.yellow('RepairingToolCall')}: ${toolCall.toolName}`,
    );

    const tool = tools[toolCall.toolName as keyof typeof tools];

    const { output } = await generateText({
      model,
      output: Output.object({ schema: tool.inputSchema }),
      prompt: [
        `The model tried to call the tool "${toolCall.toolName}"` +
          ` with the following inputs:`,
        JSON.stringify(toolCall.input),
        `The tool accepts the following schema:`,
        JSON.stringify(inputSchema(toolCall)),
        'Please fix the inputs.',
      ].join('\n'),
    });

    return { ...toolCall, input: JSON.stringify(output) };
  };
}
