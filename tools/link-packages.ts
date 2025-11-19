import { execSync } from 'child_process';
import { join } from 'node:path';

const projects = ['agent', 'retrieval', 'orchestrator', 'toolbox','text2sql'];
for (const project of [...projects]) {
  const dir = join(process.cwd(), 'packages', project);
  execSync(`npm link --force`, { cwd: dir });
  console.log(`Linked ${project}`);
}

console.log(`Link command: "npm link @deepagents/{${projects.join(',')}}"`);
