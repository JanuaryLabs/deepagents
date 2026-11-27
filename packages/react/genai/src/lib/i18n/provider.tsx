import { DirectionProvider } from '@zukhruf/shadcn';
import { type ReactNode, createContext, use } from 'react';
import type { StreamdownTranslations } from 'streamdown';

import {
  type GenaiMessageHelpers,
  type GenaiMessages,
  en,
} from './messages.ts';

type MessagesContextValue = {
  locale: string;
  dir: 'ltr' | 'rtl';
  messages: GenaiMessages;
};

const GenaiMessagesContext = createContext<MessagesContextValue>({
  locale: 'en',
  dir: 'ltr',
  messages: en,
});

function localeDirection(locale: string) {
  const { direction } = new Intl.Locale(locale).getTextInfo();
  if (!direction) {
    throw new Error(
      `Intl knows no text direction for the locale "${locale}": give GenaiMessagesProvider its dir.`,
    );
  }
  return direction;
}

export function GenaiMessagesProvider({
  locale,
  dir = localeDirection(locale),
  messages,
  children,
}: {
  locale: string;
  dir?: 'ltr' | 'rtl';
  /** The words to change; every other key keeps the enclosing provider's. */
  messages?: Partial<GenaiMessages>;
  children: ReactNode;
}) {
  const parent = use(GenaiMessagesContext);
  return (
    <GenaiMessagesContext
      value={{
        locale,
        dir,
        messages: {
          ...parent.messages,
          ...messages,
          markdown: { ...parent.messages.markdown, ...messages?.markdown },
        },
      }}
    >
      <DirectionProvider direction={dir}>{children}</DirectionProvider>
    </GenaiMessagesContext>
  );
}

/** Streamdown's words from the enclosing providers. */
export function useGenaiMarkdown(): Partial<StreamdownTranslations> {
  return use(GenaiMessagesContext).messages.markdown;
}

type TextKey = Exclude<keyof GenaiMessages, 'markdown'>;

type MessageArgs<K extends TextKey> = GenaiMessages[K] extends (
  args: infer Args,
  helpers: GenaiMessageHelpers,
) => string
  ? [args: Args]
  : [];

export type GenaiTranslate = <K extends TextKey>(
  key: K,
  ...args: MessageArgs<K>
) => string;

// A method's parameters compare bivariantly, so every message of the catalog
// is one of these, whatever its own arguments are.
type AnyMessage =
  | string
  | { render(args: unknown, helpers: GenaiMessageHelpers): string }['render'];

export function useGenaiMessages(): GenaiTranslate {
  const { locale, messages } = use(GenaiMessagesContext);
  const rules = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  const helpers: GenaiMessageHelpers = {
    format: (value) => numbers.format(value),
    plural: (count, forms) =>
      (forms[rules.select(count)] ?? forms.other).replaceAll(
        '#',
        numbers.format(count),
      ),
  };
  return (key: TextKey, args?: unknown) => {
    const message: AnyMessage = messages[key];
    return typeof message === 'string' ? message : message(args, helpers);
  };
}
