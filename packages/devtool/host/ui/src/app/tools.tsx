import type { ComponentRegistry } from '@deepagents/react-genai';

import { askUserQuestionTool } from './ask-user-question.tsx';

export const TOOL_REGISTRY = {
  ask_user_question: askUserQuestionTool,
} satisfies ComponentRegistry;
