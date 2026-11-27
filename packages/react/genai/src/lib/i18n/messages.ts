export type PluralForms = Partial<
  Record<Exclude<Intl.LDMLPluralRule, 'other'>, string>
> & { other: string };

export type GenaiMessageHelpers = {
  /** The form `Intl.PluralRules` picks for `count`, with `#` as the formatted count. */
  plural: (count: number, forms: PluralForms) => string;
  format: (value: number) => string;
};

type Message<Args> = (args: Args, helpers: GenaiMessageHelpers) => string;

/** How a finished group of steps ended. */
export type SettledStepsStatus = 'complete' | 'error' | 'aborted';

export type GenaiMessages = {
  'citation.source': Message<{ index: number }>;
  'citation.open': string;
  'message.copy': string;
  'message.copied': string;
  'message.regenerate': string;
  'message.copyDebugJson': string;
  'steps.working': string;
  'steps.reasoning': Message<{ detail: string | undefined }>;
  'steps.reasoned': Message<{ detail: string | undefined }>;
  /** One finished step drawn as `name(args)`. */
  'steps.call': Message<{ call: string; status: SettledStepsStatus }>;
  'steps.tools': Message<{ count: number; status: SettledStepsStatus }>;
  'steps.unnamedTool': string;
  'steps.unknownStep': string;
};

export const en: GenaiMessages = {
  'citation.source': ({ index }, { format }) => `Source ${format(index)}`,
  'citation.open': 'Open the source',
  'message.copy': 'Copy message',
  'message.copied': 'Copied',
  'message.regenerate': 'Regenerate response',
  'message.copyDebugJson': 'Copy debug JSON',
  'steps.working': 'Working...',
  'steps.reasoning': ({ detail }) =>
    detail ? `Reasoning ${detail}` : 'Reasoning',
  'steps.reasoned': ({ detail }) =>
    detail ? `Reasoned ${detail}` : 'Reasoned',
  'steps.call': ({ call, status }) =>
    ({
      complete: `Called ${call}`,
      error: `Failed ${call}`,
      aborted: `Cancelled ${call}`,
    })[status],
  'steps.tools': ({ count, status }, { plural }) =>
    ({
      complete: plural(count, { one: 'Ran # tool', other: 'Ran # tools' }),
      error: plural(count, {
        one: 'Ran # tool with issues',
        other: 'Ran # tools with issues',
      }),
      aborted: plural(count, {
        one: 'Cancelled after running # tool',
        other: 'Cancelled after running # tools',
      }),
    })[status],
  'steps.unnamedTool': 'Tool',
  'steps.unknownStep': 'Step',
};
