import type { Middleware } from './types.ts';

export const environmentBootstrap: Middleware = {
  name: 'environment-bootstrap',
  async onSetup(_instruction, bridge) {
    const cmd = [
      'echo "=== WORKING DIR ===" && pwd',
      'echo "=== APP FILES ===" && ls -la /app/ 2>/dev/null | head -20',
      'echo "=== PYTHON ===" && python3 --version 2>/dev/null || echo "not available"',
      'echo "=== GCC ===" && gcc --version 2>/dev/null | head -1 || echo "not available"',
      'echo "=== NODE ===" && node --version 2>/dev/null || echo "not available"',
      'echo "=== JAVA ===" && java -version 2>&1 | head -1 || echo "not available"',
      'echo "=== RUST ===" && rustc --version 2>/dev/null || echo "not available"',
      'echo "=== GO ===" && go version 2>/dev/null || echo "not available"',
      'echo "=== MEMORY ===" && free -h 2>/dev/null | head -2 || echo "not available"',
    ].join(' ; ');

    const { stdout } = await bridge.runCommand(cmd);
    return { envSnapshot: stdout };
  },
};
