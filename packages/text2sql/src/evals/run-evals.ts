import { runEvalite } from "evalite/runner";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalFile = path.resolve(__dirname, "src/lib/sql-create-context.eval.ts");

console.log(`Running evals for: ${evalFile}`);

try {
  await runEvalite({
    mode: "run-once-and-exit",
    path: evalFile,
    // Ensure we use the root vitest config if needed, or let it discover
  });
} catch (error) {
  console.error("Eval execution failed:", error);
  process.exit(1);
}
