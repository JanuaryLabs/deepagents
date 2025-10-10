import { type Agent, agent, instructions } from '../agent.ts';

export const SYSTEM_PROMPT = `

You are a multifunctional blog-generator swarm arranged in a mesh topology.
Your job is to collaborate through a structured, multi-step process to take a user's request and produce a polished article. Follow the instructions of the currently active agent precisely.


`.trim();

const outline = agent({
  name: 'blog_outline_writer_agent',
  handoffDescription: `A helpful agent that crafts concise blog post outlines.`,
  prompt: instructions({
    purpose: 'You are a professional blog outline/toc writer agent.',
    routine: [
      `Create 1-3 headings.`,
      '0-3 bullets each.',
      'produce the results in <outline></outline> tag.',
      'transfer_to_blog_writer_agent',
    ],
  }),
  handoffs: [() => writer],
});

const writer: Agent = agent({
  name: 'blog_writer_agent',
  handoffDescription: `A helpful agent that writes blog posts.`,
  prompt: instructions({
    purpose: [
      `You are a professional blog writer. Write a complete blog post based on the provided outline and user requirements.`,
    ],
    routine: [
      `Follow the outline provided in <outline></outline> tag.`,
      `Ensure the content is engaging and well-structured.`,
      `If no outline is provided, ask manager_agent to route to blog_outline_writer_agent first.`,
      `produce the results in <draft></draft> tag.`,
      'transfer_to_blog_editor_agent',
    ],
  }),
  handoffs: [() => editor, () => outline],
});

const editor = agent({
  name: 'blog_editor_agent',
  handoffDescription: `An editorial agent that reviews and refines blog posts for quality and accuracy.`,
  prompt: instructions({
    purpose:
      'Tighten writing, fix issues, ensure correctness and fit for audience; keep voice consistent.',
    routine: [
      `Tighten writing, fix issues, ensure correctness and fit for audience; keep voice consistent.`,
      `Check that the tone and length match the requirements.`,
      `Ensure the content is appropriate for the target audience.`,
      `Verify code examples are correct and runnable.`,
      `If major changes are needed, provide specific feedback in <feedback></feedback> tag and hand back to manager_agent.`,
      `If only minor edits are needed, make the corrections directly in <final></final> tag.`,
      // 'transfer_to_manager_agent',
    ],
  }),
  handoffs: [() => writer, () => outline],
});

export const triage = agent({
  name: 'triage_agent',
  handoffDescription: `Handoff to the triage_agent to handle the request.`,
  prompt: instructions({
    purpose:
      'You are a helpful triaging agent. You can use your tools to delegate questions to other appropriate agents.',
    routine: [
      // `MANDATORY EXECUTION SEQUENCE:`,
      // `triage_agent["Agent: triage_agent"]`,
      // `blog_outline_writer_agent["Agent: blog_outline_writer_agent"]`,
      // `blog_writer_agent["Agent: blog_writer_agent"]`,
      // `blog_editor_agent["Agent: blog_editor_agent"]`,
      // `blog_composer_agent["Agent: blog_composer_agent"]`,
      // `triage_agent -- transfer_to_blog_outline_writer_agent --> blog_outline_writer_agent`,
      // `triage_agent -- transfer_to_blog_writer_agent --> blog_writer_agent`,
      // `triage_agent -- transfer_to_blog_editor_agent --> blog_editor_agent`,
      // `triage_agent -- transfer_to_blog_composer_agent --> blog_composer_agent`,
      // `blog_composer_agent -- transfer_to_blog_writer_agent --> blog_writer_agent`,
      // `blog_composer_agent -- transfer_to_blog_outline_writer_agent --> blog_outline_writer_agent`,
      // `blog_composer_agent -- transfer_to_blog_editor_agent --> blog_editor_agent`,
      // `blog_editor_agent -- transfer_to_blog_writer_agent --> blog_writer_agent`,
      // `blog_editor_agent -- transfer_to_blog_composer_agent --> blog_composer_agent`,
      // `blog_editor_agent -- transfer_to_blog_outline_writer_agent --> blog_outline_writer_agent`,
      // `blog_outline_writer_agent -- transfer_to_blog_writer_agent --> blog_writer_agent`,
      // `blog_writer_agent -- transfer_to_blog_editor_agent --> blog_editor_agent`,
      // `blog_writer_agent -- transfer_to_blog_outline_writer_agent --> blog_outline_writer_agent`,
    ],
  }),
  handoffs: [() => outline, () => writer, () => editor],
});
// const response = await swarm(
//   triage,
//   [
//     messageToUiMessage(
//       `
//       I'd like to write a blog named "Gentle intro to TypeScript generics."
//         - target audience: c++ developers
//         - tone: funny
//         - length: one of short, medium, long -> I want short
//         - runnable code examples
//       `,
//     ),
//   ],
//   {},
//   SYSTEM_PROMPT,
// );

// await stdoutWrite(response);
