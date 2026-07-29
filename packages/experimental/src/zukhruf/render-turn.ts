import type { UIMessageChunk } from 'ai';
import { styleText } from 'node:util';

const dim = (text: string) => styleText('dim', text);
const red = (text: string) => styleText('red', text);

function oneLine(value: unknown, max = 88): string {
  const text = String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeToolCall(toolName: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'spawn_agent':
      return `⇄ spawn ${args.agent_type} "${args.task_name}" — ${args.message}`;
    case 'send_message':
      return `⇄ mail ${args.target} — ${args.message}`;
    case 'followup_task':
      return `⇄ follow-up ${args.target} — ${args.message}`;
    case 'list_agents':
      return '⇄ list agents';
    default:
      return `· ${toolName}`;
  }
}

/**
 * Render one turn stream as a conversation: assistant text streams raw, each
 * tool call becomes a single dim line, and failures become a single red line.
 * Reasoning shows up only as one dim ellipsis so silence never looks like a
 * hang. Everything else in the chunk vocabulary is deliberately dropped.
 */
export async function renderTurn(
  stream: ReadableStream<UIMessageChunk>,
): Promise<void> {
  const toolNames = new Map<string, string>();
  let midText = false;
  let thinkingShown = false;
  const breakText = () => {
    if (midText) process.stdout.write('\n');
    midText = false;
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'reasoning-start':
        if (!thinkingShown) {
          console.log(dim('…'));
          thinkingShown = true;
        }
        break;
      case 'text-delta':
        process.stdout.write(chunk.delta);
        midText = true;
        break;
      case 'text-end':
        breakText();
        break;
      case 'tool-input-available':
        toolNames.set(chunk.toolCallId, chunk.toolName);
        breakText();
        console.log(dim(describeToolCall(chunk.toolName, chunk.input)));
        break;
      case 'tool-output-error':
        breakText();
        console.log(
          red(
            `✗ ${toolNames.get(chunk.toolCallId) ?? 'tool'}: ${oneLine(chunk.errorText)}`,
          ),
        );
        break;
      case 'error':
        breakText();
        console.log(red(`✗ ${oneLine(chunk.errorText)}`));
        break;
      case 'abort':
        breakText();
        console.log(dim('· turn aborted'));
        break;
    }
  }
  breakText();
}
