import { pipe } from '../pipe.ts';
import { runDBreifAgent } from './brief.agent.ts';
import db, { dbPath } from './db.ts';
import { inspector } from './introspector.ts';
import { text2sqlAgent } from './text2sql.agent.ts';

const introspection = inspector(db);
const userInput =
  'Which tracks are our top‑selling songs-based on total revenue generated from each track?';

// await printer.stdout(
//   stream(
//     synthesiserAgent,
//     [
//       user(
//         dedent`
//         Based on the SQL query provided, please explain in clear, conversational language what insights or information this query is intended to retrieve from the database.

//         <user-input>${userInput}</user-input>
//         <generated-sql>${sql}</generated-sql>
//         <sql-result>${JSON.stringify(db.prepare(sql).all())}</sql-result>
//         `,
//       ),
//     ],
//     {
//       input: userInput,
//       schema: introspection,
//       context: await runDBreifAgent(introspection, dbPath),
//     },
//   ),
// );

class Text2Sql {
  public async toSql(input: string) {
    const pipeline = pipe(text2sqlAgent, runDBreifAgent());
    const stream = pipeline([], {
      introspection,
      dbPath,
    });
  }
}

const text2sql = new Text2Sql();

const sql = await text2sql.toSql(
  'List the names of all artists in the database.',
);

console.log('Generated SQL:', sql);
