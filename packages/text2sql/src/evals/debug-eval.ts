#!/usr/bin/env npx tsx
/**
 * Interactive eval debugger with multi-model variant support
 *
 * Usage:
 *   nx run text2sql:eval-debug           # Show failing tests and pick one
 *   nx run text2sql:eval-debug --list    # Just list failing tests
 *   nx run text2sql:eval-debug 5         # Run test at index 5
 *
 * Selection formats:
 *   5                                    # Test at index 5 (first match)
 *   chinook:5                            # Test 5 from chinook eval
 *   chinook:groq:5                       # Test 5 from chinook with Groq variant
 *
 * Re-running:
 *   EVAL_INDEX=17 nx run text2sql:eval src/evals/sql-create-context/sql-create-context.eval.ts
 */
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../node_modules/.evalite/cache.sqlite');

interface FailingTest {
  resultId: number;
  evalName: string;
  variantName: string | null;
  filepath: string;
  testIndex: number;
  question: string;
  score: number;
  rationale: string;
  output: string;
  expected: string;
}

function getFailingTests(): FailingTest[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const query = `
    SELECT
      r.id as result_id,
      e.name as eval_name,
      e.variant_name,
      e.filepath,
      r.col_order as test_index,
      r.input,
      r.output,
      r.expected,
      s.score,
      s.metadata
    FROM results r
    JOIN evals e ON r.eval_id = e.id
    JOIN scores s ON s.result_id = r.id
    JOIN runs ru ON e.run_id = ru.id
    WHERE s.score < 1
      AND ru.id = (SELECT MAX(id) FROM runs)
    ORDER BY e.name, e.variant_name, r.col_order, s.score ASC
  `;

  const stmt = db.prepare(query);
  const rows = stmt.all() as Array<{
    result_id: number;
    eval_name: string;
    variant_name: string | null;
    filepath: string;
    test_index: number;
    input: string;
    output: string;
    expected: string;
    score: number;
    metadata: string | null;
  }>;

  db.close();

  // Deduplicate by result_id (keep lowest score)
  const seen = new Map<number, FailingTest>();

  for (const row of rows) {
    if (seen.has(row.result_id)) continue;

    const input = JSON.parse(row.input);
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};

    seen.set(row.result_id, {
      resultId: row.result_id,
      evalName: row.eval_name,
      variantName: row.variant_name,
      filepath: row.filepath,
      testIndex: row.test_index,
      question: input.question ?? JSON.stringify(input).slice(0, 80),
      score: row.score,
      rationale: metadata.rationale ?? 'No rationale',
      output: row.output,
      expected: row.expected,
    });
  }

  return Array.from(seen.values());
}

/** Get display key for grouping (includes variant if present) */
function getGroupKey(test: FailingTest): string {
  return test.variantName
    ? `${test.evalName} (${test.variantName})`
    : test.evalName;
}

function printTests(tests: FailingTest[]) {
  console.log('\n\x1b[1m\x1b[31mFailing Tests from Latest Run:\x1b[0m\n');

  const grouped = Map.groupBy(tests, getGroupKey);

  for (const [groupName, evalTests] of grouped) {
    console.log(`\x1b[1m${groupName}\x1b[0m`);
    for (const test of evalTests ?? []) {
      const scoreColor = test.score === 0 ? '\x1b[31m' : '\x1b[33m';
      console.log(
        `  [${test.testIndex}] ${scoreColor}${test.score.toFixed(2)}\x1b[0m ${test.question}`,
        `\n- ${chalk.yellow('Rationale')}: ${test.rationale}`,
        `\n- ${chalk.green('Expected')}: ${test.expected.slice(0, 100)}`,
        `\n- ${chalk.red('Output')}: ${test.output.slice(0, 100)}\n`,
      );
    }
    console.log();
  }
}

async function promptSelection(
  tests: FailingTest[],
): Promise<FailingTest | null> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      '\x1b[1mEnter test to debug [eval:variant:index or index] (q to quit): \x1b[0m',
      (answer) => {
        rl.close();

        if (answer.toLowerCase() === 'q') {
          resolve(null);
          return;
        }

        const parts = answer.split(':');
        let evalName: string | undefined;
        let variantName: string | undefined;
        let index: number;

        if (parts.length === 3) {
          // Format: evalName:variantName:index
          evalName = parts[0];
          variantName = parts[1];
          index = parseInt(parts[2], 10);
        } else if (parts.length === 2) {
          // Format: evalName:index (backward compat) or variantName:index
          evalName = parts[0];
          index = parseInt(parts[1], 10);
        } else {
          // Format: just index
          index = parseInt(answer, 10);
        }

        const test = tests.find((t) => {
          if (t.testIndex !== index) return false;
          if (
            evalName &&
            !t.evalName.toLowerCase().includes(evalName.toLowerCase())
          ) {
            // Also check if it matches variant name
            if (
              !t.variantName?.toLowerCase().includes(evalName.toLowerCase())
            ) {
              return false;
            }
          }
          if (
            variantName &&
            !t.variantName?.toLowerCase().includes(variantName.toLowerCase())
          ) {
            return false;
          }
          return true;
        });

        if (!test) {
          console.log('\x1b[31mTest not found\x1b[0m');
          resolve(null);
          return;
        }

        resolve(test);
      },
    );
  });
}

function runSingleTest(test: FailingTest) {
  const displayName = test.variantName
    ? `${test.evalName} (${test.variantName})`
    : test.evalName;

  console.log(
    `\n\x1b[1mRunning test ${test.testIndex} from ${displayName}...\x1b[0m\n`,
  );
  console.log('\x1b[2mQuestion:\x1b[0m', test.question);
  console.log('\x1b[2mExpected:\x1b[0m', test.expected);
  if (test.variantName) {
    console.log('\x1b[2mVariant:\x1b[0m', test.variantName);
  }
  console.log();

  // Get the relative filepath from the eval
  const evalFile = test.filepath;

  const child = spawn('npx', ['evalite', 'run', evalFile], {
    cwd: resolve(__dirname, '../..'),
    env: {
      ...process.env,
      EVAL_INDEX: String(test.testIndex),
      // Note: evalite.each() runs all variants; filtering by variant would need evalite support
    },
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
\x1b[1mEval Debugger\x1b[0m (with multi-model variant support)

Usage:
  nx run text2sql:eval-debug           Interactive mode - pick a failing test
  nx run text2sql:eval-debug --list    List all failing tests
  nx run text2sql:eval-debug 5         Run test at index 5

Selection formats:
  5                                    Test at index 5 (first match)
  chinook:5                            Test 5 from chinook eval
  chinook:groq:5                       Test 5 from chinook with Groq variant

Environment Variables:
  EVAL_INDEX=5  When running evalite, only run test at this index
`);
    return;
  }

  const tests = getFailingTests();

  if (tests.length === 0) {
    console.log('\x1b[32m✓ No failing tests in the latest run!\x1b[0m');
    return;
  }

  printTests(tests);

  if (args.includes('--list') || args.includes('-l')) {
    return;
  }

  // Check if index was passed as argument
  const indexArg = args.find((a) => /^\d+$/.test(a));
  if (indexArg) {
    const test = tests.find((t) => t.testIndex === parseInt(indexArg, 10));
    if (test) {
      runSingleTest(test);
      return;
    }
    console.log('\x1b[31mTest not found at index', indexArg, '\x1b[0m');
    return;
  }

  const selected = await promptSelection(tests);
  if (selected) {
    runSingleTest(selected);
  }
}

main().catch(console.error);
