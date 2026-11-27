import type { ToolUIPart } from 'ai';
import type { StreamdownTranslations } from 'streamdown';

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
  'steps.thinking': string;
  'steps.cancelledByUser': string;
  'chat.greeting': string;
  'chat.retry': string;
  'status.loading': string;
  'composer.attachFiles': string;
  'composer.commandMenu': string;
  'composer.send': string;
  'composer.stop': string;
  'dictation.start': string;
  'dictation.starting': string;
  'dictation.stop': string;
  'dictation.transcribing': string;
  'dictation.cancel': string;
  'dictation.cancelTranscription': string;
  'dictation.unsupported': string;
  /** The browser's microphone permission is denied. */
  'dictation.blocked': string;
  'dictation.permissionDenied': string;
  'dictation.noMicrophone': string;
  'dictation.microphoneInUse': string;
  'dictation.interrupted': string;
  'dictation.transcriptionFailed': string;
  'queue.remove': string;
  'message.attachments': string;
  'message.reminders': Message<{ count: number }>;
  /** A message's token usage; the figures come formatted, in compact form. */
  'message.usage': Message<{
    input: string;
    output: string;
    total: string | undefined;
    cached: string | undefined;
  }>;
  'attachment.image': string;
  'attachment.untitled': string;
  /** The label before a file's name and media type. */
  'attachment.file': string;
  'attachment.download': string;
  'approval.request': Message<{ tool: string }>;
  'approval.approve': string;
  'approval.deny': string;
  'snapshot.copy': string;
  'snapshot.copying': string;
  'snapshot.copiedImage': string;
  'snapshot.copiedText': string;
  'snapshot.clipboardUnavailable': string;
  'snapshot.imageUnsupported': string;
  'snapshot.copyFailed': string;
  'response.renderFailed': Message<{ error: string }>;
  'tool.executing': Message<{ tool: string }>;
  'tool.state': Message<{ state: ToolUIPart['state'] }>;
  'tool.parameters': string;
  'tool.result': string;
  'tool.error': string;
  'tool.renderFailed': string;
  'tool.details': string;
  'tool.askToFix': string;
  'indexing.running': string;
  'indexing.done': string;
  'indexing.failed': string;
  'indexing.adapters': Message<{ count: number }>;
  'indexing.cacheHit': string;
  'indexing.refreshed': string;
  'indexing.queued': string;
  /** Streamdown's words; a key left out keeps streamdown's English. */
  markdown: Partial<StreamdownTranslations>;
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
  'steps.thinking': 'Thinking...',
  'steps.cancelledByUser': 'Cancelled by user',
  'chat.greeting': 'How can I help today?',
  'chat.retry': 'Try Again',
  'status.loading': 'Loading',
  'composer.attachFiles': 'Attach files',
  'composer.commandMenu': 'Toggle command menu',
  'composer.send': 'Send prompt',
  'composer.stop': 'Stop streaming',
  'dictation.start': 'Start dictation',
  'dictation.starting': 'Starting dictation',
  'dictation.stop': 'Stop dictation',
  'dictation.transcribing': 'Transcribing…',
  'dictation.cancel': 'Cancel dictation',
  'dictation.cancelTranscription': 'Cancel transcription',
  'dictation.unsupported': 'Dictation is not available in this browser',
  'dictation.blocked':
    'Allow microphone access in your browser settings to use dictation',
  'dictation.permissionDenied': 'Allow microphone access to use dictation',
  'dictation.noMicrophone': 'Connect a microphone to use dictation',
  'dictation.microphoneInUse': 'Close other apps using the microphone',
  'dictation.interrupted': 'Recording interrupted',
  'dictation.transcriptionFailed': 'Unable to transcribe audio',
  'queue.remove': 'Remove queued message',
  'message.attachments': 'Attached files',
  'message.reminders': ({ count }, { plural }) =>
    plural(count, {
      one: '# reminder attached',
      other: '# reminders attached',
    }),
  'message.usage': ({ input, output, total, cached }) =>
    [
      `↑ ${input}`,
      `↓ ${output}`,
      ...(total === undefined ? [] : [`· ${total} tokens`]),
      ...(cached === undefined ? [] : [`(${cached} cached)`]),
    ].join(' '),
  'attachment.image': 'Attached image',
  'attachment.untitled': 'Untitled',
  'attachment.file': 'File:',
  'attachment.download': 'Download',
  'approval.request': ({ tool }) => `${tool} approval`,
  'approval.approve': 'Approve',
  'approval.deny': 'Deny',
  'snapshot.copy': 'Copy snapshot',
  'snapshot.copying': 'Copying snapshot',
  'snapshot.copiedImage': 'Copied snapshot',
  'snapshot.copiedText': 'Copied text',
  'snapshot.clipboardUnavailable': 'Clipboard access is not available here.',
  'snapshot.imageUnsupported': 'Image copy is not supported in this browser.',
  'snapshot.copyFailed': 'Copy failed. Please try again.',
  'response.renderFailed': ({ error }) => `Failed to render content: ${error}`,
  'tool.executing': ({ tool }) => `Executing ${tool}`,
  'tool.state': ({ state }) =>
    ({
      'input-streaming': 'Pending',
      'input-available': 'Running',
      'approval-requested': 'Awaiting Approval',
      'approval-responded': 'Responded',
      'output-available': 'Completed',
      'output-error': 'Error',
      'output-denied': 'Denied',
    })[state],
  'tool.parameters': 'Parameters',
  'tool.result': 'Result',
  'tool.error': 'Error',
  'tool.renderFailed': 'Failed to render tool',
  'tool.details': 'View details',
  'tool.askToFix': 'Ask AI to fix this',
  'indexing.running': 'Indexing',
  'indexing.done': 'Schema indexed',
  'indexing.failed': 'Failed',
  'indexing.adapters': ({ count }, { plural }) =>
    plural(count, { one: '# adapter', other: '# adapters' }),
  'indexing.cacheHit': 'cache hit',
  'indexing.refreshed': 'refreshed',
  'indexing.queued': 'queued',
  markdown: {},
};
