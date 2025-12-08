/**
 * Convert HuggingFace model to GGUF format using Docker
 * Uses the official llama.cpp image - no local installation needed
 *
 * Usage: node convert-to-gguf.ts <model_dir> <output.gguf> [quantization]
 *
 * Arguments:
 *   model_dir     Path to HuggingFace model directory (contains model.safetensors)
 *   output.gguf   Output path for the GGUF file
 *   quantization  Quantization type (default: q8_0)
 *                 Options: f32, f16, bf16, q8_0, q4_0, q4_1, q5_0, q5_1
 *
 * Examples:
 *   node convert-to-gguf.ts ./qwen3-sql-final ./qwen3-sql.gguf
 *   node convert-to-gguf.ts ./qwen3-sql-final ./qwen3-sql-q4.gguf q4_0
 */

import spawn from 'nano-spawn';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';

const DOCKER_IMAGE = 'ghcr.io/ggml-org/llama.cpp:full';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Convert HuggingFace model to GGUF format using Docker

Usage: node convert-to-gguf.ts <model_dir> <output.gguf> [quantization]

Arguments:
  model_dir     Path to HuggingFace model directory
  output.gguf   Output path for the GGUF file
  quantization  Quantization type (default: q8_0)
                Options: f32, f16, bf16, q8_0, q4_0, q4_1, q5_0, q5_1

Examples:
  node convert-to-gguf.ts ./qwen3-sql-final ./qwen3-sql.gguf
  node convert-to-gguf.ts ./qwen3-sql-final ./qwen3-sql-q4.gguf q4_0
`);
    process.exit(args.length < 2 ? 1 : 0);
  }

  const [modelDir, outputFile, quantType = 'q8_0'] = args;

  // Validate model directory
  if (!existsSync(modelDir)) {
    console.error(`Error: Model directory not found: ${modelDir}`);
    process.exit(1);
  }

  // Ensure output directory exists
  const outputDir = dirname(resolve(outputFile));
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const modelPath = resolve(modelDir);
  const outputPath = resolve(outputDir);
  const outputName = basename(outputFile);

  console.log('Converting model to GGUF format...');
  console.log(`  Input:  ${modelPath}`);
  console.log(`  Output: ${outputPath}/${outputName}`);
  console.log(`  Quantization: ${quantType}`);
  console.log('');

  await spawn('docker', [
    'run', '--rm',
    '-v', `${modelPath}:/model:ro`,
    '-v', `${outputPath}:/output`,
    DOCKER_IMAGE,
    'python3', '/app/convert_hf_to_gguf.py',
    '/model',
    '--outfile', `/output/${outputName}`,
    '--outtype', quantType,
  ], {
    stdio: 'inherit',
  });

  console.log('');
  console.log(`Done! GGUF model saved to: ${outputPath}/${outputName}`);
}

main().catch((err) => {
  console.error('Conversion failed:', err.message);
  process.exit(1);
});
