import { DeniedCalls } from '../policy/denied-calls.ts';
import { GroundedNames, InScope } from '../policy/in-scope.ts';
import { OneSelect } from '../policy/one-select.ts';
import { SourcePolicy } from '../policy/source-policy.ts';
import { SqlText } from '../policy/sql-text.ts';

/** The default policy of the Sqlite adapter. */
export function policy() {
  return new SourcePolicy(
    // SQLite's grammar over-reserves identifiers such as COUNT and PERSIST;
    // MySQL is the established lenient fallback for those valid SQLite names.
    new SqlText({ dialects: ['sqlite', 'mysql'] }),
    [
      new OneSelect(),
      new DeniedCalls({
        names: ['EDIT', 'LOAD_EXTENSION', 'READFILE', 'WRITEFILE'],
      }),
      new InScope(new GroundedNames()),
    ],
  );
}
