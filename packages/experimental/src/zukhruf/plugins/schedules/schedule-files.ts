import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

import type { ScheduleControl, ScheduleSource } from './index.ts';

const FILE_KEY_PREFIX = 'zukhruf:schedule-file:';
const frontmatterSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    cron: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
  })
  .strict();

export function scheduleFiles({
  directory,
  ownerId,
}: {
  directory: string | URL;
  ownerId: string;
}): ScheduleSource {
  return (scheduled) => syncScheduleFiles(directory, ownerId, scheduled);
}

/** Synchronize immediate Markdown declarations into durable scheduled tasks. */
async function syncScheduleFiles(
  directory: string | URL,
  ownerId: string,
  scheduled: ScheduleControl,
): Promise<void> {
  const directoryPath =
    directory instanceof URL ? fileURLToPath(directory) : directory;
  const declarations = await Promise.all(
    (
      await readdir(directoryPath, {
        withFileTypes: true,
      })
    )
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith('.') &&
          extname(entry.name) === '.md',
      )
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        try {
          const match = (
            await readFile(join(directoryPath, entry.name), 'utf8')
          ).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
          if (!match) throw new Error('missing or malformed frontmatter');
          const frontmatter = frontmatterSchema.parse(YAML.parse(match[1]));
          const prompt = match[2].trim();
          if (!prompt) throw new Error('prompt cannot be empty');
          return {
            idempotencyKey: `${FILE_KEY_PREFIX}${entry.name}`,
            name: frontmatter.name ?? basename(entry.name, extname(entry.name)),
            prompt,
            recurrence: frontmatter.cron,
            timezone: frontmatter.timezone,
            executionConfig: {},
          };
        } catch (cause) {
          throw new Error(`Invalid schedule declaration ${entry.name}`, {
            cause,
          });
        }
      }),
  );
  const existing = (await scheduled.list(ownerId)).filter(
    ({ idempotencyKey }) => idempotencyKey.startsWith(FILE_KEY_PREFIX),
  );
  const existingByKey = new Map(
    existing.map((task) => [task.idempotencyKey, task]),
  );
  for (const declaration of declarations) {
    if (existingByKey.get(declaration.idempotencyKey)?.status === 'archived') {
      throw new Error(
        `Schedule declaration ${declaration.idempotencyKey.slice(FILE_KEY_PREFIX.length)} is archived`,
      );
    }
  }

  for (const declaration of declarations) {
    const current = existingByKey.get(declaration.idempotencyKey);
    if (!current) {
      await scheduled.create(ownerId, declaration);
      continue;
    }
    let task = current;
    if (
      task.name !== declaration.name ||
      task.prompt !== declaration.prompt ||
      task.recurrence !== declaration.recurrence ||
      task.timezone !== declaration.timezone ||
      Object.keys(task.executionConfig).length > 0
    ) {
      task = await scheduled.update(ownerId, task.id, declaration);
    }
    if (task.status === 'paused') await scheduled.resume(ownerId, task.id);
  }

  const present = new Set(
    declarations.map(({ idempotencyKey }) => idempotencyKey),
  );
  for (const task of existing) {
    if (task.status === 'active' && !present.has(task.idempotencyKey)) {
      await scheduled.pause(ownerId, task.id);
    }
  }
}
