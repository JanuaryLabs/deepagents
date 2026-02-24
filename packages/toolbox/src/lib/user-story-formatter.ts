import { tool } from 'ai';
import z from 'zod';

import { toState } from './state.ts';

const AcceptanceCriteriaSchema = z.object({
  criterion: z.string().describe('A specific, testable acceptance criterion'),
});

const UserStorySchema = z.object({
  title: z.string().describe('Clear, concise title for the user story'),
  userRole: z
    .string()
    .describe('The user role or persona (e.g., "developer", "end user")'),
  action: z.string().describe('What the user wants to do'),
  benefit: z.string().describe('The value or benefit the user gets'),
  acceptanceCriteria: z
    .array(AcceptanceCriteriaSchema)
    .describe('List of specific, testable conditions that must be met'),
  technicalNotes: z
    .string()
    .optional()
    .describe(
      'Relevant files, components, or dependencies from the repository',
    ),
  priority: z
    .enum(['High', 'Medium', 'Low'])
    .describe('Priority level based on complexity and dependencies'),
  storyPoints: z
    .enum(['1', '2', '3', '5', '8', '13'])
    .describe('Estimated complexity using Fibonacci sequence'),
  epicOrFeature: z
    .string()
    .optional()
    .describe('The epic or feature group this story belongs to'),
});

export const user_story_formatter_tool = tool({
  description: `Tool for formatting and recording user stories in a standardized format.

    Use this tool to create well-structured user stories following product management best practices.
    Each story should follow the format: "As a [role], I want to [action], so that [benefit]"

    When to use:
    - After analyzing a feature or component in the codebase
    - When you've gathered enough information to write a complete user story
    - To document findings in a structured, actionable format
    - To maintain consistency across all generated user stories

    The tool will:
    1. Format the story in the standard user story template
    2. Store it in the context for later synthesis
    3. Return a formatted version for immediate review
`,
  inputSchema: UserStorySchema,
  execute: async (story, options) => {
    const context = toState<{ userStories: (typeof story)[] }>(options);
    context.userStories ??= [];
    context.userStories.push(story);

    // Format the user story for output
    const formatted = `
## ${story.title}

**User Story:**
As a **${story.userRole}**, I want to **${story.action}**, so that **${story.benefit}**.

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac.criterion}`).join('\n')}

**Technical Notes:**
${story.technicalNotes || 'N/A'}

**Priority:** ${story.priority}
**Story Points:** ${story.storyPoints}
${story.epicOrFeature ? `**Epic/Feature:** ${story.epicOrFeature}` : ''}

---
`.trim();

    return `User story recorded successfully!\n\n${formatted}\n\nTotal stories recorded: ${context.userStories.length}`;
  },
});
