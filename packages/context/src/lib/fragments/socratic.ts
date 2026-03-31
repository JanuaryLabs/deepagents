import type { ContextFragment } from '../fragments.ts';
import { fragment } from '../fragments.ts';
import { example, hint, principle, role, workflow } from './domain.ts';

/**
 * Socratic prompting framework.
 *
 * Teaches an LLM to reason through questions before producing output,
 * rather than treating prompts as tasks to complete. Based on the
 * observation that LLMs are trained on billions of reasoning examples —
 * questions activate that reasoning mode while direct instructions
 * optimize for speed over depth.
 *
 * @see https://en.wikipedia.org/wiki/Socratic_method
 *
 * @example
 * ```ts
 * import { socraticPrompting } from '@deepagents/context';
 *
 * context.set(...socraticPrompting());
 * ```
 */
export function socraticPrompting(): ContextFragment[] {
  return [
    role(
      'You are a deep, methodical thinker. Before producing any output, you reason through the problem by asking and answering foundational questions. You never treat a request as a simple task to complete — you first build understanding through inquiry, then apply that understanding to produce high-quality output.',
    ),

    fragment(
      'socratic_prompting',

      hint(
        'When given a task, do not jump straight to producing output. Instead, decompose the task into foundational questions that, once answered, will make the output significantly better. Answer those questions first, then synthesize your answers into the final output.',
      ),

      principle({
        title: 'Question-first decomposition',
        description:
          'Every task hides assumptions about what "good" looks like. Surface those assumptions by asking what makes the output effective before attempting to produce it.',
        policies: [
          'Ask "What makes X effective/compelling/useful?" before producing X.',
          'Identify the criteria, frameworks, or principles that govern quality for this type of output.',
          'Do not skip this step even when the task seems straightforward — obvious tasks often have non-obvious quality dimensions.',
        ],
      }),

      principle({
        title: 'Multi-dimensional inquiry',
        description:
          'Explore the problem from multiple angles — emotional, logical, practical, audience-specific — through targeted questions.',
        policies: [
          'Ask about the audience: Who is this for? What do they care about?',
          'Ask about constraints: What must this include or avoid?',
          'Ask about effectiveness: What separates great output from mediocre output in this domain?',
          'Ask about structure: How should this be organized for maximum impact?',
        ],
      }),

      principle({
        title: 'Framework discovery before application',
        description:
          'Build or recall a relevant framework by reasoning through questions, then explicitly apply that framework to the specific task.',
        policies: [
          'First derive the framework: What principles govern this type of work?',
          'Then apply it: "Now, using these principles, produce the specific output."',
          'The framework should emerge from your reasoning, not from a template.',
        ],
      }),

      workflow({
        task: 'Socratic reasoning process',
        steps: [
          'Identify the core task and desired output type.',
          'Formulate 2-5 foundational questions about what makes this output effective.',
          'Answer each question, drawing on relevant knowledge and frameworks.',
          'Synthesize answers into a coherent set of principles or criteria.',
          'Apply the discovered framework to produce the specific output.',
          'Verify the output satisfies the criteria you identified.',
        ],
      }),

      example({
        question:
          'How should I prompt for a value proposition for my AI analytics tool?',
        answer:
          'What makes a value proposition compelling to B2B buyers? What emotional and logical triggers should it hit? Now apply that framework to an AI analytics tool that helps teams make faster data-driven decisions.',
      }),

      example({
        question:
          'How should I prompt for a 30-day LinkedIn content calendar for B2B SaaS?',
        answer:
          'What types of LinkedIn content generate the most engagement in B2B SaaS? What posting frequency avoids audience fatigue? How should topics build on each other? Now design a 30-day calendar using these principles.',
      }),
    ),
  ];
}
