/**
 * TypeScript runner for the Python fine-tuning script.
 * Uses an isolated virtual environment - no global Python pollution.
 *
 * Usage:
 *   npx tsx packages/text2sql/src/finetune/run-finetune.ts [options]
 *
 * Options:
 *   --epochs <n>        Number of training epochs (default: 3)
 *   --batch-size <n>    Per-device batch size (default: 4)
 *   --lr <rate>         Learning rate (default: 1e-4)
 *   --output-dir <dir>  Output directory (default: ./qwen3-sql-lora)
 *   --max-samples <n>   Limit training samples
 *   --use-hf            Use HuggingFace dataset instead of local
 *   --model <name>      Base model (default: Qwen/Qwen3-0.6B)
 *   --no-gguf           Disable automatic GGUF conversion
 *   --gguf-type <type>  GGUF quantization type (default: q8_0)
 *
 * Prerequisites:
 *   brew install llama.cpp  # Required for GGUF conversion
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths for the virtual environment
const VENV_DIR = join(__dirname, '.venv');
const isWindows = process.platform === 'win32';
const VENV_PYTHON = isWindows
  ? join(VENV_DIR, 'Scripts', 'python.exe')
  : join(VENV_DIR, 'bin', 'python');
const VENV_PIP = isWindows
  ? join(VENV_DIR, 'Scripts', 'pip.exe')
  : join(VENV_DIR, 'bin', 'pip');
const REQUIREMENTS_FILE = join(__dirname, 'requirements.txt');

interface FinetuneOptions {
  epochs?: number;
  batchSize?: number;
  lr?: number;
  outputDir?: string;
  maxSamples?: number;
  useHf?: boolean;
  model?: string;
  evalSplit?: number;
  noGguf?: boolean;
  ggufType?: string;
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
    proc.on('error', (err) => {
      // Try python instead of python3
      const proc2 = spawn('python', ['-m', 'venv', VENV_DIR], {
        stdio: 'inherit',
      });
      proc2.on('close', (code) => {
        if (code === 0) {
          console.log('Virtual environment created.');
          resolve();
        } else {
          reject(new Error(`Failed to create venv: ${err.message}`));
        }
      });
      proc2.on('error', reject);
    });
  });
}

function checkDepsInstalled(): boolean {
  const result = spawnSync(VENV_PYTHON, ['-c', 'import trl, peft, datasets'], {
    stdio: 'pipe',
  });
  return result.status === 0;
}

async function installDeps(): Promise<void> {
  console.log('Installing Python dependencies into venv...');
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

function runFinetune(options: FinetuneOptions): ChildProcess {
  const scriptPath = join(__dirname, 'finetune_sql.py');

  if (!existsSync(scriptPath)) {
    throw new Error(`Python script not found: ${scriptPath}`);
  }

  const args: string[] = [scriptPath];

  if (options.epochs !== undefined) {
    args.push('--epochs', String(options.epochs));
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
  if (options.evalSplit !== undefined) {
    args.push('--eval-split', String(options.evalSplit));
  }
  if (options.noGguf) {
    args.push('--no-gguf');
  }
  if (options.ggufType !== undefined) {
    args.push('--gguf-type', options.ggufType);
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
      epochs: { type: 'string', short: 'e' },
      'batch-size': { type: 'string', short: 'b' },
      lr: { type: 'string' },
      'output-dir': { type: 'string', short: 'o' },
      'max-samples': { type: 'string', short: 'n' },
      'use-hf': { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      'eval-split': { type: 'string' },
      'no-gguf': { type: 'boolean' },
      'gguf-type': { type: 'string' },
      'skip-venv-check': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Fine-tune Qwen3 0.6B on sql-create-context dataset

Uses an isolated virtual environment at:
  ${VENV_DIR}

Usage:
  npx tsx run-finetune.ts [options]

Options:
  -e, --epochs <n>        Number of training epochs (default: 3)
  -b, --batch-size <n>    Per-device batch size (default: 4)
      --lr <rate>         Learning rate (default: 2e-5)
  -o, --output-dir <dir>  Output directory (default: ./qwen3-sql)
  -n, --max-samples <n>   Limit training samples (for testing)
      --use-hf            Use HuggingFace dataset (78k examples)
  -m, --model <name>      Base model (default: Qwen/Qwen3-0.6B)
      --eval-split <r>    Eval split ratio (default: 0.1)
      --no-gguf           Disable automatic GGUF conversion
      --gguf-type <type>  GGUF quantization (default: q8_0)
      --skip-venv-check   Skip venv setup (use existing)
  -h, --help              Show this help message

Prerequisites:
  brew install llama.cpp  # Required for GGUF conversion

Examples:
  # Quick test with 100 samples
  npx tsx run-finetune.ts --max-samples 100 --epochs 1

  # Full training with HuggingFace dataset
  npx tsx run-finetune.ts --use-hf --epochs 3

  # Custom model and output
  npx tsx run-finetune.ts --model Qwen/Qwen3-1.7B --output-dir ./my-sql-model

Output:
  The script outputs both HuggingFace and GGUF formats:
    ./qwen3-sql-final/       # HuggingFace format
    ./qwen3-sql-final.gguf   # GGUF format (ready for LMStudio/Ollama)

After Training - Using the Model:

  LMStudio:
    lms import ./qwen3-sql-final.gguf --user-repo local/qwen3-sql
    lms load local/qwen3-sql --gpu max

  Ollama:
    echo 'FROM ./qwen3-sql-final.gguf' > Modelfile
    ollama create qwen3-sql -f Modelfile
    ollama run qwen3-sql
`);
    process.exit(0);
  }

  // Setup virtual environment
  if (!values['skip-venv-check']) {
    await ensureVenv();
    console.log();
  }

  const options: FinetuneOptions = {
    epochs: values.epochs ? parseInt(values.epochs, 10) : undefined,
    batchSize: values['batch-size'] ? parseInt(values['batch-size'], 10) : undefined,
    lr: values.lr ? parseFloat(values.lr) : undefined,
    outputDir: values['output-dir'],
    maxSamples: values['max-samples'] ? parseInt(values['max-samples'], 10) : undefined,
    useHf: values['use-hf'],
    model: values.model,
    evalSplit: values['eval-split'] ? parseFloat(values['eval-split']) : undefined,
    noGguf: values['no-gguf'],
    ggufType: values['gguf-type'],
  };

  const proc = runFinetune(options);

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
