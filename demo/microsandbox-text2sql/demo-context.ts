import {
  ContextEngine,
  type ContextFragment,
  type DisposableSandbox,
  InMemoryContextStore,
} from '@deepagents/context';
import { instructions } from '@deepagents/text2sql';

/**
 * Shared ContextEngine for the demo. Fragments here are **sandbox-agnostic**:
 * they teach SQL semantics, query workflows, error recovery, and the
 * `sql run <db> "SELECT ..."` invocation form — every demo (docker, daytona,
 * any future backend) gets a `sql` command via its sandbox of choice.
 *
 * Per-sandbox concerns (image selection, env wiring) stay in the individual
 * demo files. Schema seeding is also shared — see `index()`.
 */
export const defaultFragments: ContextFragment[] = instructions();

const context = new ContextEngine({
  chatId: 'text2sql-demo',
  userId: 'demo-user',
  store: new InMemoryContextStore(),
});

export default context;

/**
 * Run `sql index` inside the given sandbox, read the manifest, and return the
 * generated `ContextFragment[]`. Shared across backends — the sandbox's
 * `executeCommand` and `readFile` are the only seam.
 */
export async function index(
  sandbox: DisposableSandbox,
): Promise<ContextFragment[]> {
  const result = await sandbox.executeCommand('sql index');
  if (result.exitCode !== 0) {
    throw new Error(`sql index failed: ${result.stderr}`);
  }
  const manifest = JSON.parse(result.stdout) as { fragmentsPath: string };
  return JSON.parse(
    await sandbox.readFile(manifest.fragmentsPath),
  ) as ContextFragment[];
}
