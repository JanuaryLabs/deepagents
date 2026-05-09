import type { SqlCommand } from '../command.ts';
import { IndexCommand } from './index.ts';
import { RunCommand } from './run.ts';
import { ValidateCommand } from './validate.ts';

export const commands: readonly SqlCommand[] = [
  new RunCommand(),
  new ValidateCommand(),
  new IndexCommand(),
];
