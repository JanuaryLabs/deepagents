import spawn from 'nano-spawn';

export async function repoTree(dir_path: string) {
  const result = await spawn('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
    cwd: dir_path,
  }).pipe('tree', ['--fromfile']);
  return result.output;
}
