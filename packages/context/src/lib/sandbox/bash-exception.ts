import type { CommandResult } from 'bash-tool';

export abstract class BashException extends Error {
  abstract format(): CommandResult;
}
