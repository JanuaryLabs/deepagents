import { type Agent, agent, instructions } from '../agent.ts';

export const SYSTEM_PROMPT = `
You are a multifunctional blog-generator swarm arranged in a star topology.
Your job is to collaborate through a structured, multi-step process to take a user's request and produce a polished article. Follow the instructions of the currently active agent precisely.
`.trim();

const outliner = agent({
  name: 'blog_outline_writer_agent',
  handoffDescription: `A helpful agent that crafts concise blog post outlines.`,
  prompt: instructions.supervisor_subagent({
    purpose: [
      `You are a professional blog outline/toc writer agent. if you are requested then supervisor_agent have forward the task to you. Create a detailed outline for the blog post and forward back to supervisor_agent.`,
    ],
    routine: [
      `Create 1-3 headings.`,
      '0-3 bullets each.',
      'produce the results in <outline></outline> tag.',
    ],
  }),
  handoffs: [() => blogSupervisor],
});

const writer = agent({
  name: 'blog_writer_agent',
  handoffDescription: `A helpful agent that writes blog posts.`,
  prompt: instructions.supervisor_subagent({
    purpose: [
      `You are a professional blog writer. Write a complete blog post based on the provided outline and user requirements.`,
    ],
    routine: [
      `Follow the outline provided in <outline></outline> tag.`,
      // `Follow the research provided in <research></research> tag.`,
      `Ensure the content is engaging and well-structured.`,
      `If no outline is provided, ask supervisor_agent to route to blog_outline_writer_agent first.`,
      `MANDATORY: Produce the complete blog post wrapped in <draft></draft> tags.`,
      `IMPORTANT: Your entire blog post content must be inside the <draft></draft> tags.`,
    ],
  }),
  handoffs: [() => blogSupervisor],
});

const editor = agent({
  name: 'blog_editor_agent',
  handoffDescription: `An editorial agent that reviews and refines blog posts for quality and accuracy.`,
  prompt: instructions.supervisor_subagent({
    purpose: [
      `You are a professional editor reviewing blog posts for technical accuracy, clarity, and engagement.`,
    ],
    routine: [
      `Tighten writing, fix issues, ensure correctness and fit for audience; keep voice consistent.`,
      `Check that the tone and length match the requirements.`,
      `Ensure the content is appropriate for the target audience.`,
      `Ensure outline is following the outline provided in <outline></outline> tag.`,
      // 'Ensure the content is following the research provided in <research></research> tag.',
      `Verify code examples are correct and runnable.`,
      `MANDATORY: Choose ONE of these two options:`,
      `OPTION 1: If major changes are needed, provide specific feedback in <feedback></feedback> tag.`,
      `OPTION 2: If only minor edits are needed OR content is good, make the final version in <final></final> tag.`,
      `IMPORTANT: You MUST use either <feedback></feedback> OR <final></final> tags in your response.`,
    ],
  }),
  handoffs: [() => blogSupervisor],
});

export const blogSupervisor: Agent = agent({
  name: 'supervisor_agent',
  prompt: instructions.supervisor({
    purpose: [
      `You are a helpful orchestrator agent that coordinates the blog writing process by delegating tasks to specialized agents based on user requests and the current state of the blog post.`,
      `You cannot do any writing or editing yourself.`,
      `Transfers to specialized agents are achieved by calling a transfer function, named \`transfer_to_<agent_name>\`.`,
      'To see the latest result of the agents before you look into the messages',
      `When a specialized agent forwards back to you but without producing any result you should blame it so and ask it to produce a result before handing back to you.`,
    ],
    routine: [
      `CRITICAL: You must complete the ENTIRE sequence. Do not stop after any single step. Each step must be completed before proceeding to the next.`,
      `MANDATORY EXECUTION SEQUENCE:`,
      // `supervisor_agent → research_agent (MUST complete)`,
      // `research_agent → supervisor_agent (MUST return)`,
      `supervisor_agent → blog_outline_writer_agent (MUST complete)`,
      `blog_outline_writer_agent → supervisor_agent (MUST return)`,
      `IMMEDIATELY after receiving outline: supervisor_agent → blog_writer_agent (MUST forward)`,
      `blog_writer_agent → supervisor_agent (MUST return)`,
      `IMMEDIATELY after receiving draft: supervisor_agent → blog_editor_agent (MUST forward)`,
      `blog_editor_agent → supervisor_agent (MUST return)`,
      `IF blog_editor_agent returns <feedback>…</feedback>: supervisor_agent → blog_writer_agent (MUST forward with that feedback), then blog_writer_agent → supervisor_agent (MUST return), then supervisor_agent → blog_editor_agent (MUST forward). Repeat this loop until no <feedback> is returned.`,
      `IF blog_editor_agent returns <final>…</final> (no feedback): supervisor_agent → user (MUST deliver final blog post)`,
      `Remember: NEVER stop the sequence until the final blog post is delivered to the user.`,
    ],
  }),
  handoffs: [
    outliner,
    writer,
    editor,
    // researchAgent([() => blogSupervisor])
  ],
});

// const response = await execute(
//   blogSupervisor,
//   [
//     messageToUiMessage(
//       `
//       I'd like to write a blog named "Gentle intro to TypeScript generics max of half page."
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
