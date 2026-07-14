/**
 * Skills module for Anthropic-style progressive disclosure.
 *
 * Skills are modular packages that extend an agent's capabilities with
 * specialized knowledge, workflows, and tools. They use progressive
 * disclosure to minimize context window usage:
 *
 * 1. At startup: the application supplies skill metadata (name, description,
 *    and model-visible path)
 * 2. At runtime: LLM reads full SKILL.md using file tools when relevant
 * 3. As needed: LLM navigates to references/, scripts/, assets/
 *
 * @example
 * ```ts
 * import { skills } from '@deepagents/context';
 *
 * const availableSkills = [{
 *   name: 'deploy',
 *   description: 'Deploy services to production.',
 *   path: '/skills/deploy/SKILL.md',
 * }];
 *
 * const context = new ContextEngine({ userId: 'demo-user', store, chatId: 'demo' })
 *   .set(
 *     role('You are a helpful assistant.'),
 *     skills(availableSkills),
 *   );
 *
 * // LLM sees the supplied paths and reads full content when needed
 * ```
 *
 * @module
 */

export * from './fragments.ts';
export * from './frontmatter.ts';
export * from './skill-reminder.ts';
export * from './types.ts';
