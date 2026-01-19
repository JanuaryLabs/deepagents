/**
 * Skills module for Anthropic-style progressive disclosure.
 *
 * Skills are modular packages that extend an agent's capabilities with
 * specialized knowledge, workflows, and tools. They use progressive
 * disclosure to minimize context window usage:
 *
 * 1. At startup: only skill metadata (name + description) is loaded
 * 2. At runtime: LLM reads full SKILL.md using file tools when relevant
 * 3. As needed: LLM navigates to references/, scripts/, assets/
 *
 * @example
 * ```ts
 * import { skills } from '@deepagents/context';
 *
 * // Add skills metadata to context with sandbox path mapping
 * const context = new ContextEngine({ userId: 'demo-user', store, chatId: 'demo' })
 *   .set(
 *     role('You are a helpful assistant.'),
 *     skills({
 *       paths: [
 *         { host: './skills', sandbox: '/skills/local' },
 *         { host: '~/.deepagents/skills', sandbox: '/skills/global' }
 *       ]
 *     }),
 *   );
 *
 * // LLM sees sandbox paths and reads full content when needed
 * ```
 *
 * @module
 */

export * from './fragments.ts';
export * from './loader.ts';
export * from './types.ts';
