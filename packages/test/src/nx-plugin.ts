import type {
  PostTasksExecution,
  PreTasksExecution,
  PreTasksExecutionContext,
  ProjectGraph,
  TaskGraph,
} from '@nx/devkit';
import spawn from 'nano-spawn';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMysqlContainer } from './mysql-container.ts';
import { startPostgresContainer } from './postgres-container.ts';
import {
  type ProvisionedServer,
  TEST_SERVERS_ENV,
} from './provisioned-servers.ts';
import {
  SQL_SERVER_FULL_IMAGE,
  startSqlServerContainer,
} from './sqlserver-container.ts';

const RUN_LABEL = 'dev.deepagents.test.nx-run';

async function testRequirements(
  context: PreTasksExecutionContext,
): Promise<Set<string>> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-test-graph-'),
  );
  const graphFile = join(directory.path, 'tasks.json');
  const args = context.argv.slice(1);
  const separator = args.indexOf('--');
  args.splice(
    separator === -1 ? args.length : separator,
    0,
    `--graph=${graphFile}`,
  );
  // Nx's --graph branch returns before task hooks. Let Nx resolve run/run-many/
  // affected, exclusions and dependencies instead of duplicating its CLI parser.
  await spawn(process.execPath, args, { cwd: context.workspaceRoot });
  const { graph, tasks }: { graph: ProjectGraph; tasks: TaskGraph } =
    JSON.parse(await readFile(graphFile, 'utf8'));
  const requirements = new Set<string>();
  for (const task of Object.values(tasks.tasks)) {
    if (task.target.target !== 'test') continue;
    const tags = graph.nodes[task.target.project].data.tags;
    if (tags) for (const tag of tags) requirements.add(tag);
  }
  return requirements;
}

export const preTasksExecution: PreTasksExecution = async (_, context) => {
  const requirements = await testRequirements(context);
  const labels = { [RUN_LABEL]: context.id };
  const resources = new AsyncDisposableStack();
  const servers: ProvisionedServer[] = [];
  try {
    if (requirements.has('test:postgres')) {
      servers.push({
        ...resources.use(await startPostgresContainer({ labels })),
        engine: 'postgres',
      });
    }
    if (requirements.has('test:mysql')) {
      servers.push({
        ...resources.use(await startMysqlContainer({ labels })),
        engine: 'mysql',
      });
    }
    let hasFullSqlServer = false;
    if (requirements.has('test:sqlserver')) {
      const server = resources.use(await startSqlServerContainer({ labels }));
      servers.push({ ...server, engine: 'sqlserver' });
      hasFullSqlServer = server.image === SQL_SERVER_FULL_IMAGE;
    }
    if (requirements.has('test:sqlserver-full') && !hasFullSqlServer) {
      servers.push({
        ...resources.use(
          await startSqlServerContainer({
            image: SQL_SERVER_FULL_IMAGE,
            labels,
          }),
        ),
        engine: 'sqlserver',
      });
    }
    // One assignment publishes only this run's servers, including an empty set.
    process.env[TEST_SERVERS_ENV] = JSON.stringify(servers);
    // Nx may unload this worker while another run is still active. Docker's
    // labels retain ownership across worker restarts; the post-hook releases it.
    resources.move();
  } finally {
    // Startup failure happens before Nx's post-hook; release any earlier servers.
    await resources.disposeAsync();
  }
};

export const postTasksExecution: PostTasksExecution = async (_, context) => {
  const requirements = await testRequirements(context);
  if (
    ![
      'test:postgres',
      'test:mysql',
      'test:sqlserver',
      'test:sqlserver-full',
    ].some((tag) => requirements.has(tag))
  )
    return;
  const { stdout } = await spawn('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${RUN_LABEL}=${context.id}`,
  ]);
  if (stdout.trim())
    await spawn('docker', ['stop', ...stdout.trim().split('\n')]);
};
