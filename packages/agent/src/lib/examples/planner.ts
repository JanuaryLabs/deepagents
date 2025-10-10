import { Listr, type ListrTask } from 'listr2';

/**
 * Common progress message sets for typical operations
 */
export const ProgressMessages = {
  WRITING: [
    'Planning report structure...',
    'Writing sections...',
    'Finalizing report...',
  ] as string[],
  ANALYZING: [
    'Processing data...',
    'Running analysis...',
    'Generating insights...',
  ] as string[],
  SEARCHING: [
    'Executing searches...',
    'Gathering results...',
    'Processing findings...',
  ] as string[],
  PROCESSING: [
    'Starting processing...',
    'Working on task...',
    'Finalizing results...',
  ] as string[],
};

export function createProgress<Ctx>(...tasks: ListrTask<Ctx>[]) {
  return new Listr<Ctx>(tasks, {
    rendererOptions: {
      collapseSubtasks: false,
    },
  });
}

export function withMessageProgress(update: (message: string) => void) {
  const messages = ProgressMessages.WRITING;
  let i = 0;
  const interval = setInterval(() => {
    update(messages[i % messages.length]);
    i++;
  }, 5000);
  return {
    [Symbol.dispose]: () => {
      clearInterval(interval);
    },
  };
}
