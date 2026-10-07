import {
  ContextEngine,
  type ContextFragment,
  type DisposableSandbox,
  InMemoryContextStore,
  isFragment,
} from '@deepagents/context';
import { instructions } from '@deepagents/text2sql';

/**
 * Shared ContextEngine for the demo. Fragments here are **sandbox-agnostic**:
 * they teach SQL semantics, query workflows, error recovery, and the
 * `sql run <db> "SELECT ..."` invocation form — every demo (docker, agent-os,
 * any future backend) gets a `sql` command via its sandbox of choice.
 *
 * Per-sandbox concerns (volume mounts, env wiring) stay in the individual
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
 * generated `ContextFragment[]`. Shared by both docker and agent-os demos —
 * the sandbox's `executeCommand` and `readFile` are the only seam.
 */
export async function index(
  sandbox: DisposableSandbox,
): Promise<ContextFragment[]> {
  const result = await sandbox.executeCommand('sql index');
  if (result.exitCode !== 0) {
    throw new Error(`sql index failed: ${result.stderr}`);
  }
  const manifest: unknown = JSON.parse(result.stdout);
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('fragmentsPath' in manifest) ||
    typeof manifest.fragmentsPath !== 'string'
  ) {
    throw new Error(`sql index printed no fragmentsPath: ${result.stdout}`);
  }
  const fragments: unknown = JSON.parse(
    await sandbox.readFile(manifest.fragmentsPath),
  );
  if (!Array.isArray(fragments) || !fragments.every(isFragment)) {
    throw new Error(`${manifest.fragmentsPath} is not a list of fragments`);
  }
  return fragments;
}
