import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = join(process.cwd(), 'packages');
const projects = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
    );
    return manifest.private !== true;
  })
  .map((entry) => entry.name);

execSync('nx run-many -t build', { stdio: 'inherit', cwd: process.cwd() });
for (const project of projects) {
  execSync(`npm link --force`, { cwd: join(packagesDir, project) });
  console.log(`Linked ${project}`);
}

console.log(`Link command: "npm link @deepagents/{${projects.join(',')}}"`);
