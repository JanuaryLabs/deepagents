import { CornerDownRight } from 'lucide-react';

import { defineElements, useAgent } from '@deepagents/react-genai';

function FollowUp({ question }: { question?: string }) {
  const { submit } = useAgent();
  if (!question) return null;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground my-1 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors"
      onClick={() => submit({ prompt: question, persistedPrompt: question })}
    >
      <CornerDownRight className="size-3.5" />
      {question}
    </button>
  );
}

export const INTERACTIVE_ELEMENTS = defineElements([
  {
    name: 'followup',
    description:
      'Suggest a follow-up question the user is likely to ask next. Renders as a clickable chip that sends the question as the next message. Example: <followup question="How do I undo this?" />',
    allowedAttributes: ['question'],
    component: FollowUp,
  },
]);
