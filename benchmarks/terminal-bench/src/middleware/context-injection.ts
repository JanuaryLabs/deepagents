import type { Middleware } from './types.ts';

export const contextInjection: Middleware = {
  name: 'context-injection',
  async onSetup(_instruction, bridge) {
    const cmd = [
      'echo "=== FILE TREE ===" && find /app -maxdepth 3 -type f 2>/dev/null | head -100',
      'echo "=== README ===" && cat /app/README.md 2>/dev/null | head -50 || cat README.md 2>/dev/null | head -50',
      'echo "=== MAKEFILE ===" && cat /app/Makefile 2>/dev/null | head -30 || cat Makefile 2>/dev/null | head -30',
      'echo "=== GIT LOG ===" && git log --oneline -5 2>/dev/null',
    ].join(' ; ');

    const { stdout } = await bridge.runCommand(cmd);
    return { discoveredContext: stdout };
  },
};
