import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

const DATASETS_DIR = '.evals/datasets';

const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl', '.csv']);

export interface DatasetEntry {
  name: string;
  extension: string;
  sizeBytes: number;
}

function ensureDir() {
  mkdirSync(DATASETS_DIR, { recursive: true });
}

export function listDatasets(): DatasetEntry[] {
  ensureDir();
  const files = readdirSync(DATASETS_DIR);
  return files
    .filter(
      (f) =>
        ALLOWED_EXTENSIONS.has(extname(f).toLowerCase()) &&
        !f.endsWith('.hf.json'),
    )
    .map((f) => {
      const stat = statSync(join(DATASETS_DIR, f));
      return { name: f, extension: extname(f), sizeBytes: stat.size };
    });
}

export function datasetPath(name: string): string {
  return join(DATASETS_DIR, basename(name));
}

export function saveDataset(name: string, content: ArrayBuffer | string): void {
  ensureDir();
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type: ${ext}. Allowed: .json, .jsonl, .csv`,
    );
  }
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const buf = typeof content === 'string' ? content : Buffer.from(content);
  writeFileSync(join(DATASETS_DIR, sanitized), buf);
}

export function deleteDataset(name: string): void {
  const filepath = join(DATASETS_DIR, basename(name));
  if (!existsSync(filepath)) {
    throw new Error(`Dataset "${name}" not found`);
  }
  unlinkSync(filepath);
}
