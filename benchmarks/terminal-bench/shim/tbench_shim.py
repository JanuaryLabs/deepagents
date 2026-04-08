"""
Thin Python shim bridging Harbor's BaseAgent to a TypeScript agent process.
Spawns `node benchmarks/terminal-bench/src/main.ts` and relays
environment commands over stdio JSON lines.
"""

import json
import os
import subprocess
import sys

from harbor.agents.base import BaseAgent


class TBenchAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "tbench"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment) -> None:
        pass

    async def run(self, instruction, environment, context) -> None:
        repo_root = os.environ.get(
            "TBENCH_REPO_ROOT",
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")),
        )
        entry = os.path.join(repo_root, "benchmarks", "terminal-bench", "src", "main.ts")

        env = {**os.environ}
        env.setdefault("LMS_BASE_URL", "http://localhost:1234/v1")
        env.setdefault("LMS_MODEL", "default")

        proc = subprocess.Popen(
            ["node", "--no-warnings", entry],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            env=env,
            text=True,
            bufsize=1,
        )

        start_msg = json.dumps({
            "type": "start",
            "instruction": instruction,
            "taskId": getattr(context, "task_id", "unknown"),
        })
        proc.stdin.write(start_msg + "\n")
        proc.stdin.flush()

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)

            if msg["type"] == "run":
                result = await environment.exec(msg["command"])
                response = json.dumps({
                    "type": "run_result",
                    "id": msg["id"],
                    "stdout": result.stdout or "",
                    "stderr": result.stderr or "",
                    "returnCode": result.return_code,
                })
                proc.stdin.write(response + "\n")
                proc.stdin.flush()

            elif msg["type"] == "context":
                context.n_input_tokens = (
                    (context.n_input_tokens or 0) + msg.get("inputTokens", 0)
                )
                context.n_output_tokens = (
                    (context.n_output_tokens or 0) + msg.get("outputTokens", 0)
                )

            elif msg["type"] == "complete":
                break

        proc.stdin.close()
        proc.wait(timeout=10)
