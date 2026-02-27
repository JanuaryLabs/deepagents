import {
  mkdirSync,
  readFileSync,
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

export interface HfDatasetRef {
  dataset: string;
  config: string;
  split: string;
}

export function isHfDataset(name: string): boolean {
  return name.endsWith('.hf.json');
}

function ensureDir() {
  mkdirSync(DATASETS_DIR, { recursive: true });
}

export function listDatasets(): DatasetEntry[] {
  ensureDir();
  const files = readdirSync(DATASETS_DIR);
  return files
    .filter(
      (f) => isHfDataset(f) || ALLOWED_EXTENSIONS.has(extname(f).toLowerCase()),
    )
    .map((f) => {
      const stat = statSync(join(DATASETS_DIR, f));
      const extension = isHfDataset(f) ? '.hf.json' : extname(f);
      return { name: f, extension, sizeBytes: stat.size };
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

export function saveHfDataset(ref: HfDatasetRef): string {
  ensureDir();
  const sanitized = `${ref.dataset}--${ref.config}--${ref.split}`.replace(
    /[^a-zA-Z0-9._-]/g,
    '_',
  );
  const filename = `${sanitized}.hf.json`;
  writeFileSync(join(DATASETS_DIR, filename), JSON.stringify(ref));
  return filename;
}

export function readHfConfig(name: string): HfDatasetRef | null {
  if (!isHfDataset(name)) return null;
  try {
    const content = readFileSync(join(DATASETS_DIR, basename(name)), 'utf-8');
    return JSON.parse(content) as HfDatasetRef;
  } catch {
    return null;
  }
}

export function deleteDataset(name: string): void {
  unlinkSync(join(DATASETS_DIR, basename(name)));
}
