import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'deepagents-packed-plugins-'));
const packs = join(temporary, 'packs');
const consumer = join(temporary, 'consumer');
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(temporary, 'npm-cache'),
};
mkdirSync(packs);
mkdirSync(consumer);
mkdirSync(join(consumer, 'agents'));

try {
  const tarballs = [
    pack('packages/agent'),
    pack('packages/context'),
    pack('packages/elements'),
    pack('packages/experimental'),
    pack('packages/react/shadcn'),
    pack('packages/devtool/history'),
    pack('packages/devtool/traces'),
    pack('packages/devtool/host'),
  ];
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-save',
      '@types/node@^26.1.1',
      ...tarballs,
    ],
    { cwd: consumer, env: npmEnvironment, stdio: 'inherit' },
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'DOM', 'ESNext.Disposable'],
        strict: true,
        skipLibCheck: true,
        types: ['node'],
        noEmit: true,
      },
      include: ['consumer.ts'],
    }),
  );
  writeFileSync(join(consumer, 'consumer.ts'), createConsumerSource());
  execFileSync(
    process.execPath,
    [
      join(workspace, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(consumer, 'tsconfig.json'),
    ],
    { cwd: consumer, stdio: 'inherit' },
  );
  execFileSync(process.execPath, [join(consumer, 'consumer.ts')], {
    cwd: consumer,
    stdio: 'inherit',
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function pack(directory: string): string {
  // npm 11 prints an array of packed manifests; npm 12 prints an object keyed
  // by package name. Both carry the tarball `filename`.
  const packed: unknown = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', packs], {
      cwd: join(workspace, directory),
      encoding: 'utf8',
      env: npmEnvironment,
    }),
  );
  const [{ filename }] = (
    Array.isArray(packed) ? packed : Object.values(packed as object)
  ) as [{ filename: string }];
  return join(packs, filename);
}

function createConsumerSource(): string {
  return String.raw`
import { devtool } from '@deepagents/devtool';
import { fileTelemetry } from '@deepagents/devtool-traces';
import { tracesHttp } from '@deepagents/devtool-traces/http';
import {
  type AgentPluginDefinition,
  AgentPluginCapability,
  AgentRuntime,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
import { http } from '@deepagents/experimental/zukhruf/http';
import {
  type SchedulingWake,
  WakeScheduler,
  conversationScheduling,
  conversationSchedulingCapabilities,
} from '@deepagents/experimental/zukhruf/conversation-scheduling';
import { fileAgents } from '@deepagents/experimental/zukhruf/file-agents';
import {
  schedules,
  schedulesCapabilities,
} from '@deepagents/experimental/zukhruf/schedules';
import { schedulesHttp } from '@deepagents/experimental/zukhruf/schedules/http';

class ConsumerWakeScheduler extends WakeScheduler<SchedulingWake> {
  schedule(): Promise<void> {
    return Promise.resolve();
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  consume(): Promise<AsyncDisposable> {
    return Promise.resolve({
      [Symbol.asyncDispose]: () => Promise.resolve(),
    });
  }
}

const hostValue = new AgentPluginCapability<string>('consumer.host-value');
const custom: AgentPluginDefinition<{ value: string }> = {
  name: 'consumer',
  capabilities: [hostValue],
  create: (bindings) => ({ value: bindings.get(hostValue) }),
};
const files = fileAgents({ directory: new URL('./agents/', import.meta.url) });
const conversation = conversationScheduling();
const scheduled = schedules({
  queue: 'consumer-schedules',
  reconciliationIntervalMs: 1,
});
const traceDefinition = fileTelemetry({ path: './telemetry.jsonl' });
const root = defineAgent({
  name: 'consumer',
  model: { provider: 'consumer', modelId: 'consumer' } as never,
  sandbox: async () => ({}) as never,
  instructions: [],
  plugins: [custom, files, conversation, scheduled, traceDefinition],
});
const scheduler = new ConsumerWakeScheduler();
const boss = { getDb: () => ({}) } as never;
const options = (value: string) => ({
  store: {} as never,
  streams: {} as never,
  queue: {} as never,
  mailboxStore: {} as never,
  bindings: [
    hostValue.bind(value),
    conversationSchedulingCapabilities.scheduler.bind(scheduler),
    conversationSchedulingCapabilities.timezone.bind('UTC'),
    schedulesCapabilities.boss.bind(boss),
    schedulesCapabilities.transaction.bind((operation) =>
      operation({} as never),
    ),
  ],
});
const first = new AgentRuntime(root, options('first'));
const second = new AgentRuntime(root, options('second'));
if (first.plugin(custom) === second.plugin(custom)) throw new Error('shared custom instance');
if (first.plugin(custom).value !== 'first') throw new Error('wrong first binding');
if (second.plugin(custom).value !== 'second') throw new Error('wrong second binding');
if (first.plugin(traceDefinition) === second.plugin(traceDefinition)) {
  throw new Error('shared file telemetry instance');
}
if (typeof http(first, tracesHttp(traceDefinition)).fetch !== 'function') {
  throw new Error('HTTP transport plugin is not mountable');
}
if (typeof http(first, schedulesHttp(scheduled)).fetch !== 'function') {
  throw new Error('schedules HTTP projection is not mountable');
}
if (
  Object.keys(schedulesHttp(scheduled).project(first as never).capabilities)[0] !==
  'schedules'
) {
  throw new Error('schedules capability is not advertised');
}
if (typeof devtool().fetch !== 'function') throw new Error('devtool is not mountable');
if (first.plugin(files) === second.plugin(files)) throw new Error('shared file-agents instance');
if (first.plugin(conversation) === second.plugin(conversation)) {
  throw new Error('shared conversation-scheduling instance');
}
if (first.plugin(scheduled) === second.plugin(scheduled)) {
  throw new Error('shared schedules instance');
}
`;
}
