import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('loads the published Node ESM entry', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "await import('@deepagents/react-genai')",
    ],
    { cwd: import.meta.dirname },
  );
}, 10_000);
