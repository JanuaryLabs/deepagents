import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  type DetectDriftInput,
  type Mode,
  type SkillEvidence,
  type SkillFinding,
  detectDrift,
} from './detect-drift.ts';
import { type FixRecord, fixLinksAndMeta } from './fix-links-meta.ts';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  cwd: string;
  mode: Mode;
  base: string;
  head: string;
  apply: boolean;
  reportDir: string;
  skipVerify: boolean;
}

export interface SkillRunReport {
  runId: string;
  mode: Mode;
  base: string;
  head: string;
  findings: SkillFinding[];
  fixesApplied: FixRecord[];
  unresolved: SkillFinding[];
  evidence: SkillEvidence[];
  exitStatus: 'ok' | 'failed';
}

function timestampId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return defaultValue;
}

function parseArgs(argv: string[], cwd: string): RunOptions {
  const args = new Map<string, string | undefined>();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, undefined);
    }
  }

  const modeValue = (args.get('mode') ?? 'on-demand') as Mode;
  const mode: Mode = modeValue === 'scheduled' ? 'scheduled' : 'on-demand';
  const base = args.get('base') ?? 'origin/main';
  const head = args.get('head') ?? 'HEAD';
  const apply = parseBoolean(args.get('apply'), true);
  const skipVerify = args.has('skip-verify')
    ? true
    : parseBoolean(args.get('skip-verify'), false);
  const reportDir =
    args.get('report-dir') ??
    path.join(cwd, 'artifacts', 'doc-gardener', timestampId());

  return {
    cwd,
    mode,
    base,
    head,
    apply,
    reportDir,
    skipVerify,
  };
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(),
    };
  }
}

function dedupeFindings(findings: SkillFinding[]): SkillFinding[] {
  const seen = new Set<string>();
  const out: SkillFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.category,
      finding.file ?? '',
      finding.title,
      finding.details,
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function groupByDomain(findings: SkillFinding[]): Map<string, SkillFinding[]> {
  const groups = new Map<string, SkillFinding[]>();
  for (const finding of findings) {
    const key = finding.packageName ?? finding.domain ?? 'workspace';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(finding);
  }
  return groups;
}

function renderReportMarkdown(report: SkillRunReport): string {
  const groups = groupByDomain(report.findings);
  const lines: string[] = [];

  lines.push('# Doc Gardener Report');
  lines.push('');
  lines.push(`- runId: ${report.runId}`);
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- base: ${report.base}`);
  lines.push(`- head: ${report.head}`);
  lines.push(`- exitStatus: ${report.exitStatus}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- findings: ${report.findings.length}`);
  lines.push(`- fixesApplied: ${report.fixesApplied.length}`);
  lines.push(`- unresolved: ${report.unresolved.length}`);
  lines.push(`- evidenceItems: ${report.evidence.length}`);
  lines.push('');

  lines.push('## Findings By Package/Domain');
  lines.push('');
  for (const [domain, domainFindings] of groups) {
    lines.push(`### ${domain}`);
    lines.push('');
    for (const finding of domainFindings) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      if (finding.file) lines.push(`  file: ${finding.file}`);
      lines.push(`  details: ${finding.details}`);
      if (finding.suggestedFix)
        lines.push(`  suggestedFix: ${finding.suggestedFix}`);
    }
    lines.push('');
  }

  lines.push('## Fixes Applied');
  lines.push('');
  if (report.fixesApplied.length === 0) {
    lines.push('- none');
  } else {
    for (const fix of report.fixesApplied) {
      lines.push(`- [${fix.type}] ${fix.file}: ${fix.before} -> ${fix.after}`);
      lines.push(`  note: ${fix.note}`);
    }
  }
  lines.push('');

  lines.push('## Unresolved');
  lines.push('');
  if (report.unresolved.length === 0) {
    lines.push('- none');
  } else {
    for (const finding of report.unresolved) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      if (finding.file) lines.push(`  file: ${finding.file}`);
      lines.push(`  details: ${finding.details}`);
      if (finding.suggestedFix)
        lines.push(`  suggestedFix: ${finding.suggestedFix}`);
    }
  }
  lines.push('');

  lines.push('## Evidence');
  lines.push('');
  for (const item of report.evidence) {
    lines.push(`- ${item.label} (${item.type})`);
    if (item.command) lines.push(`  command: ${item.command}`);
    if (item.file) lines.push(`  file: ${item.file}`);
    if (item.output) lines.push(`  output: ${item.output.slice(0, 600)}`);
    if (item.data) lines.push(`  data: ${JSON.stringify(item.data)}`);
  }
  lines.push('');

  if (report.mode === 'scheduled') {
    lines.push('## Batch PR Summary');
    lines.push('');
    for (const [domain, domainFindings] of groups) {
      lines.push(`- ${domain}: ${domainFindings.length} finding(s)`);
    }
    lines.push(`- Total fixes applied: ${report.fixesApplied.length}`);
    lines.push(`- Remaining unresolved: ${report.unresolved.length}`);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

async function verifyRun(
  options: RunOptions,
): Promise<{ finding?: SkillFinding; evidence: SkillEvidence }> {
  if (options.skipVerify) {
    return {
      evidence: {
        type: 'analysis',
        label: 'verification-skipped',
        data: { reason: 'skipVerify=true' },
      },
    };
  }

  const args =
    options.mode === 'on-demand'
      ? [
          'nx',
          'affected',
          '-t',
          'lint,test,build',
          `--base=${options.base}`,
          `--head=${options.head}`,
          '--outputStyle=static',
        ]
      : ['nx', 'run-many', '-t', 'lint,test,build', '--outputStyle=static'];

  const result = await runCommand(options.cwd, 'npx', args);
  const evidence: SkillEvidence = {
    type: 'command',
    label: 'verification-gate',
    command: `npx ${args.join(' ')}`,
    output: result.output.slice(0, 8000),
  };

  if (result.code === 0) return { evidence };

  return {
    evidence,
    finding: {
      id: 'verification-gate-failure',
      title: 'Verification gate failed',
      category: 'behavior-drift',
      severity: 'high',
      domain: 'workspace',
      details:
        'Nx lint/test/build gate failed after documentation gardening run.',
      suggestedFix:
        'Inspect verification command output and resolve failing projects before merging.',
    },
  };
}

export async function runDocGardener(
  partial: Partial<RunOptions> = {},
): Promise<SkillRunReport> {
  const cwd = partial.cwd ?? process.cwd();
  const defaults = parseArgs([], cwd);

  const options: RunOptions = {
    ...defaults,
    ...partial,
    cwd,
    reportDir: partial.reportDir ?? defaults.reportDir,
    mode: (partial.mode ?? defaults.mode) as Mode,
    base: partial.base ?? defaults.base,
    head: partial.head ?? defaults.head,
    apply: partial.apply ?? defaults.apply,
    skipVerify: partial.skipVerify ?? defaults.skipVerify,
  };

  const runId = `doc-gardener-${timestampId()}-${Math.random().toString(16).slice(2, 8)}`;

  const detectionInput: DetectDriftInput = {
    cwd: options.cwd,
    mode: options.mode,
    base: options.base,
    head: options.head,
    skipBehaviorCheck: options.skipVerify,
  };

  const initial = await detectDrift(detectionInput);
  let fixesApplied: FixRecord[] = [];

  if (options.apply) {
    const fixResult = await fixLinksAndMeta({
      cwd: options.cwd,
      findings: initial.findings,
    });
    fixesApplied = fixResult.fixesApplied;
  }

  const postIntegrityScan = await detectDrift({
    ...detectionInput,
    skipBehaviorCheck: true,
  });

  const unresolved = dedupeFindings([
    ...initial.unresolved,
    ...postIntegrityScan.findings.filter(
      (finding) => finding.category === 'docs-integrity',
    ),
  ]);

  const verification = await verifyRun(options);
  const evidence = [
    ...initial.evidence,
    ...postIntegrityScan.evidence,
    verification.evidence,
  ];
  if (verification.finding) unresolved.push(verification.finding);

  const report: SkillRunReport = {
    runId,
    mode: options.mode,
    base: options.base,
    head: options.head,
    findings: dedupeFindings(postIntegrityScan.findings),
    fixesApplied,
    unresolved: dedupeFindings(unresolved),
    evidence,
    exitStatus:
      unresolved.length === 0 && !verification.finding ? 'ok' : 'failed',
  };

  await fs.mkdir(options.reportDir, { recursive: true });
  await fs.writeFile(
    path.join(options.reportDir, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(options.reportDir, 'report.md'),
    renderReportMarkdown(report),
    'utf8',
  );

  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.cwd());
  const report = await runDocGardener(options);
  if (report.exitStatus !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
