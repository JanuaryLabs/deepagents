import {
  type ContextEngine,
  fragment,
  guardrail,
  hint,
  role,
  selfCritique,
  workflow,
} from '@deepagents/context';

export function buildSystemFragments(
  engine: ContextEngine,
  instruction: string,
  envSnapshot?: string,
  discoveredContext?: string,
) {
  engine.set(
    role(
      'You are an expert AI assistant tasked with solving command-line tasks in a Linux environment. You have access to a terminal and must complete the task autonomously.',
    ),
  );

  engine.set(
    workflow({
      task: 'Terminal task completion',
      steps: [
        'Plan & Discover: Understand the task, explore the environment, identify tools and files available.',
        'Build & Implement: Execute your plan step by step, writing code or running commands as needed.',
        'Verify & Test: Run verification commands to confirm your solution works correctly.',
        'Fix & Complete: Fix any issues found during verification, then call task_complete.',
      ],
      notes:
        'Always verify before completing. The first call to task_complete triggers a verification check.',
    }),
  );

  engine.set(
    hint(
      'Batch multiple commands in a single run_commands call to reduce turns.',
    ),
  );
  engine.set(
    hint(
      'If stuck for 3+ turns on the same issue, try a fundamentally different approach.',
    ),
  );
  engine.set(hint('You have limited time. Be efficient and focused.'));
  engine.set(
    hint(
      'Read error output carefully — it often contains the exact fix needed.',
    ),
  );

  engine.set(
    guardrail({
      rule: 'Never call task_complete without first verifying your solution works.',
    }),
  );
  engine.set(
    guardrail({
      rule: 'Do not repeat the same failing command more than twice.',
    }),
  );

  engine.set(
    selfCritique([
      'Did I address every requirement in the instruction?',
      'Did I verify my solution actually works by running it?',
      'Are there edge cases or error conditions I missed?',
    ]),
  );

  engine.set(fragment('task', instruction));

  if (envSnapshot) {
    engine.set(fragment('environment-snapshot', envSnapshot));
  }

  if (discoveredContext) {
    engine.set(fragment('discovered-context', discoveredContext));
  }
}
