import { execSync } from 'child_process';
import { join } from 'node:path';

const projects = [
  'agent',
  'retrieval',
  'orchestrator',
  'toolbox',
  'text2sql',
  'context',
];
execSync('nx run-many -t build', { stdio: 'inherit', cwd: process.cwd() });
for (const project of [...projects]) {
  const dir = join(process.cwd(), 'packages', project);
  execSync(`npm link --force`, { cwd: dir });
  console.log(`Linked ${project}`);
}

console.log(`Link command: "npm link @deepagents/{${projects.join(',')}}"`);
