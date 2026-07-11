import type { CommandResult } from './types.ts';

export abstract class BashException extends Error {
  abstract format(): CommandResult;
}
