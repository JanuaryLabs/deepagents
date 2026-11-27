import type { ToolUIPart } from 'ai';
import type { StreamdownTranslations } from 'streamdown';

import type {
  ComposerAttachmentLabel,
  ComposerPastedTextLabel,
} from '@deepagents/react-input/browser';

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
  /** Shown above the retry button when a send or stream fails. */
  'chat.error': string;
  /** The host answered 429. */
  'chat.errorRateLimited': string;
  'chat.scrollToBottom': string;
  /** The accessible name of the scrolling region that holds the messages. */
  'chat.messagesRegion': string;
  'composer.attachFiles': string;
  'composer.commandMenu': string;
  'composer.send': string;
  'composer.stop': string;
  'composer.editor': string;
  'composer.placeholder': string;
  /** Shown when the host's submit rejects with anything but a failed upload. */
  'composer.sendFailed': string;
  /** An upload the server refused with 413. */
  'composer.uploadTooLarge': string;
  /** An upload the server refused with 415. */
  'composer.uploadUnsupported': string;
  /** An upload the server refused with any other status. */
  'composer.uploadFailed': string;
  'composer.attachments': string;
  /** Names the `number`th attachment to the user: its token in the editor, its preview, its remove button and the alert for its missing file. The model still reads `[Image #N]`. */
  'composer.attachment': Message<Parameters<ComposerAttachmentLabel>[0]>;
  /** Names a pasted block of `chars` characters in the editor. The model reads the pasted text. */
  'composer.pastedText': Message<Parameters<ComposerPastedTextLabel>[0]>;
  /** `label` is what `composer.attachment` named the attachment. */
  'composer.removeAttachment': Message<{ label: string }>;
  /** The hidden file input behind the attach button. */
  'composer.attachInput': string;
  'composer.suggestions': string;
  'composer.noMatches': string;
  /** Marks a suggested command that takes arguments. */
  'composer.takesArgs': string;
  /** A file that is not an image, video or audio file; `name` is undefined for a file without one. */
  'composer.unsupportedFile': Message<{ name: string | undefined }>;
  /** A sent prompt starts with a slash command nobody knows; `name` has no slash. */
  'composer.unknownCommand': Message<{ name: string }>;
  /** A sent prompt holds an attachment whose file is gone, such as one brought back by undo; `label` is what `composer.attachment` named it. */
  'composer.attachmentMissing': Message<{ label: string }>;
  /** The prompt, its pasted content expanded, has `chars` characters, over `maxChars`. */
  'composer.promptTooLong': Message<{ chars: number; maxChars: number }>;
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
  'chat.error': 'Something went wrong. Try again.',
  'chat.errorRateLimited': 'Too many requests. Wait a moment, then try again.',
  'chat.scrollToBottom': 'Scroll to the latest message',
  'chat.messagesRegion': 'Messages',
  'composer.attachFiles': 'Attach files',
  'composer.commandMenu': 'Toggle command menu',
  'composer.send': 'Send prompt',
  'composer.stop': 'Stop streaming',
  'composer.editor': 'Rich prompt composer',
  'composer.placeholder': 'Type a message or / for commands',
  'composer.sendFailed': 'Could not send prompt',
  'composer.uploadTooLarge': 'The file is too large to upload.',
  'composer.uploadUnsupported': 'This type of file cannot be uploaded.',
  'composer.uploadFailed': 'Could not upload the file. Try again.',
  'composer.attachments': 'Attached files',
  'composer.attachment': ({ media, number }) =>
    `[${{ image: 'Image', video: 'Video', audio: 'Audio' }[media]} #${number}]`,
  'composer.pastedText': ({ chars }, { plural }) =>
    plural(chars, {
      one: '[Pasted Content # char]',
      other: '[Pasted Content # chars]',
    }),
  'composer.removeAttachment': ({ label }) => `Remove ${label}`,
  'composer.attachInput': 'Attach media files',
  'composer.suggestions': 'Suggestions',
  'composer.noMatches': 'no matches',
  'composer.takesArgs': 'args',
  'composer.unsupportedFile': ({ name }) =>
    name === undefined
      ? 'Only image, video, or audio files can be attached: unnamed file'
      : `Only image, video, or audio files can be attached: ${name}`,
  'composer.unknownCommand': ({ name }) => `Unrecognized command: /${name}`,
  'composer.attachmentMissing': ({ label }) =>
    `Attached image is no longer available: ${label}`,
  'composer.promptTooLong': ({ chars, maxChars }, { plural }) =>
    `Prompt is too long after expanding pasted content (${plural(chars, { one: '# char', other: '# chars' })}; max ${plural(maxChars, { one: '# char', other: '# chars' })}).`,
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
