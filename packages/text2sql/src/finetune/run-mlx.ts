/**
 * TypeScript runner for the MLX fine-tuning script.
 * Uses an isolated virtual environment - no global Python pollution.
 *
 * Native Apple Silicon support (M1/M2/M3/M4).
 *
 * Usage:
 *   node packages/text2sql/src/finetune/run-mlx.ts [options]
 *
 * Options:
 *   --iters <n>         Number of training iterations (default: 1000)
 *   --batch-size <n>    Batch size (default: 4)
 *   --lr <rate>         Learning rate (default: 1e-5)
 *   --output-dir <dir>  Output directory (default: ./qwen3-sql-mlx)
 *   --max-samples <n>   Limit training samples
 *   --use-hf            Use HuggingFace dataset instead of local
 *   --model <name>      Base model (default: Qwen/Qwen3-0.5B)
 *   --num-layers <n>    Number of LoRA layers (default: 16)
 *   --no-gguf           Disable GGUF export
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Separate venv for MLX
const VENV_DIR = join(__dirname, '.venv-mlx');
const VENV_PYTHON = join(VENV_DIR, 'bin', 'python');
const VENV_PIP = join(VENV_DIR, 'bin', 'pip');
const REQUIREMENTS_FILE = join(__dirname, 'requirements-mlx.txt');

interface MlxOptions {
  iters?: number;
  batchSize?: number;
  lr?: number;
  outputDir?: string;
  maxSamples?: number;
  useHf?: boolean;
  model?: string;
  numLayers?: number;
  evalSplit?: number;
  noGguf?: boolean;
}

function venvExists(): boolean {
  return existsSync(VENV_PYTHON);
}

async function createVenv(): Promise<void> {
  console.log(`Creating virtual environment at ${VENV_DIR}...`);
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'venv', VENV_DIR], {
      stdio: 'inherit',
    });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('Virtual environment created.');
        resolve();
      } else {
        reject(new Error(`Failed to create venv (exit code ${code})`));
      }
    });
    proc.on('error', reject);
  });
}

function checkDepsInstalled(): boolean {
  const result = spawnSync(VENV_PYTHON, ['-c', 'import mlx_lm'], {
    stdio: 'pipe',
  });
  return result.status === 0;
}

async function installDeps(): Promise<void> {
  console.log('Installing MLX dependencies into venv...');
  console.log('(This may take a while on first run)');
  console.log();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      VENV_PIP,
      ['install', '-r', REQUIREMENTS_FILE],
      { stdio: 'inherit' }
    );
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('Dependencies installed.');
        resolve();
      } else {
        reject(new Error(`pip install failed with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function ensureVenv(): Promise<void> {
  if (!venvExists()) {
    await createVenv();
    await installDeps();
  } else if (!checkDepsInstalled()) {
    console.log('Dependencies missing or outdated.');
    await installDeps();
  } else {
    console.log('Virtual environment ready.');
  }
}

function runMlx(options: MlxOptions): ChildProcess {
  const scriptPath = join(__dirname, 'finetune_mlx.py');

  if (!existsSync(scriptPath)) {
    throw new Error(`Python script not found: ${scriptPath}`);
  }

  const args: string[] = [scriptPath];

  if (options.iters !== undefined) {
    args.push('--iters', String(options.iters));
  }
  if (options.batchSize !== undefined) {
    args.push('--batch-size', String(options.batchSize));
  }
  if (options.lr !== undefined) {
    args.push('--lr', String(options.lr));
  }
  if (options.outputDir !== undefined) {
    args.push('--output-dir', options.outputDir);
  }
  if (options.maxSamples !== undefined) {
    args.push('--max-samples', String(options.maxSamples));
  }
  if (options.useHf) {
    args.push('--use-hf');
  }
  if (options.model !== undefined) {
    args.push('--model', options.model);
  }
  if (options.numLayers !== undefined) {
    args.push('--num-layers', String(options.numLayers));
  }
  if (options.evalSplit !== undefined) {
    args.push('--eval-split', String(options.evalSplit));
  }
  if (options.noGguf) {
    args.push('--no-gguf');
  }

  console.log(`Running: ${VENV_PYTHON} ${args.join(' ')}`);
  console.log();

  return spawn(VENV_PYTHON, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      iters: { type: 'string', short: 'i' },
      'batch-size': { type: 'string', short: 'b' },
      lr: { type: 'string' },
      'output-dir': { type: 'string', short: 'o' },
      'max-samples': { type: 'string', short: 'n' },
      'use-hf': { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      'num-layers': { type: 'string', short: 'l' },
      'eval-split': { type: 'string' },
      'no-gguf': { type: 'boolean' },
      'skip-venv-check': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
MLX Fine-Tuning (Apple Silicon native)

Uses an isolated virtual environment at:
  ${VENV_DIR}

Usage:
  node run-mlx.ts [options]

Options:
  -i, --iters <n>       Number of training iterations (default: 1000)
  -b, --batch-size <n>  Batch size (default: 4)
      --lr <rate>       Learning rate (default: 1e-5)
  -o, --output-dir <dir> Output directory (default: ./qwen3-sql-mlx)
  -n, --max-samples <n> Limit training samples (for testing)
      --use-hf          Use HuggingFace dataset (78k examples)
  -m, --model <name>    Base model (default: Qwen/Qwen3-0.5B)
  -l, --num-layers <n>  Number of LoRA layers (default: 16)
      --eval-split <r>  Eval split ratio (default: 0.1)
      --no-gguf         Disable GGUF export
      --skip-venv-check Skip venv setup (use existing)
  -h, --help            Show this help message

Examples:
  # Quick test with 100 samples
  node run-mlx.ts --max-samples 100 --iters 100

  # Full training with HuggingFace dataset
  node run-mlx.ts --use-hf --iters 1000

  # Reduce memory usage
  node run-mlx.ts --batch-size 2 --num-layers 8

Output:
  The script outputs adapters, fused model, and GGUF:
    ./qwen3-sql-mlx/data/        # Training data (JSONL)
    ./qwen3-sql-mlx/adapters/    # LoRA adapter weights
    ./qwen3-sql-mlx/fused_model/ # Merged model + GGUF

After Training - Using the Model:

  LMStudio:
    lms import ./qwen3-sql-mlx/fused_model/ggml-model-f16.gguf --user-repo local/qwen3-sql-mlx
    lms load local/qwen3-sql-mlx --gpu max

  Ollama:
    echo 'FROM ./qwen3-sql-mlx/fused_model/ggml-model-f16.gguf' > Modelfile
    ollama create qwen3-sql-mlx -f Modelfile
    ollama run qwen3-sql-mlx

  MLX Generate:
    mlx_lm.generate --model ./qwen3-sql-mlx/fused_model --prompt "Your prompt"
`);
    process.exit(0);
  }

  // Check platform
  if (process.platform !== 'darwin') {
    console.log('');
    console.log('ERROR: Not running on macOS');
    console.log('');
    console.log('MLX requires macOS with Apple Silicon (M1/M2/M3/M4).');
    console.log('');
    console.log('For other platforms, use:');
    console.log('  node run-finetune.ts [options]');
    console.log('');
    process.exit(1);
  }

  // Setup virtual environment
  if (!values['skip-venv-check']) {
    await ensureVenv();
    console.log();
  }

  const options: MlxOptions = {
    iters: values.iters ? parseInt(values.iters, 10) : undefined,
    batchSize: values['batch-size'] ? parseInt(values['batch-size'], 10) : undefined,
    lr: values.lr ? parseFloat(values.lr) : undefined,
    outputDir: values['output-dir'],
    maxSamples: values['max-samples'] ? parseInt(values['max-samples'], 10) : undefined,
    useHf: values['use-hf'],
    model: values.model,
    numLayers: values['num-layers'] ? parseInt(values['num-layers'], 10) : undefined,
    evalSplit: values['eval-split'] ? parseFloat(values['eval-split']) : undefined,
    noGguf: values['no-gguf'],
  };

  const proc = runMlx(options);

  proc.on('close', (code) => {
    process.exit(code ?? 0);
  });

  proc.on('error', (err) => {
    console.error('Failed to run Python script:', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
