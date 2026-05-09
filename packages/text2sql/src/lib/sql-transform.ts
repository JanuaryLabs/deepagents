import { BashTransformPipeline } from 'just-bash';

import {
  SqlCommandRewritePlugin,
  SqlProxyEnforcementPlugin,
  SqlProxyViolationError,
} from './agents/sql-transform-plugins.ts';

const sqlTransformPipeline = new BashTransformPipeline()
  .use(new SqlCommandRewritePlugin())
  .use(new SqlProxyEnforcementPlugin());

export function transformSqlCommand(command: string): string {
  try {
    return sqlTransformPipeline.transform(command).script;
  } catch (error) {
    if (error instanceof SqlProxyViolationError) {
      return blockedSqlProxyCommand(error.message);
    }
    return command;
  }
}

function blockedSqlProxyCommand(message: string): string {
  return `{ printf '%s\\n' ${shellQuote(message)} >&2; exit 1; }`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
