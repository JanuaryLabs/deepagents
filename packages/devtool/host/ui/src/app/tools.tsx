import type { ComponentRegistry } from '@deepagents/react-genai';

import { askUserQuestionTool } from './ask-user-question.tsx';
import { bashTool, readFileTool, writeFileTool } from './sandbox-tools.tsx';

export const TOOL_REGISTRY = {
  ask_user_question: askUserQuestionTool,
  bash: bashTool,
  readFile: readFileTool,
  writeFile: writeFileTool,
} satisfies ComponentRegistry;
