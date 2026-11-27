import { type ReactNode, createContext, use } from 'react';

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
      value={{ locale, dir, messages: { ...parent.messages, ...messages } }}
    >
      {children}
    </GenaiMessagesContext>
  );
}

type MessageArgs<K extends keyof GenaiMessages> = GenaiMessages[K] extends (
  args: infer Args,
  helpers: GenaiMessageHelpers,
) => string
  ? [args: Args]
  : [];

export type GenaiTranslate = <K extends keyof GenaiMessages>(
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
  return (key: keyof GenaiMessages, args?: unknown) => {
    const message: AnyMessage = messages[key];
    return typeof message === 'string' ? message : message(args, helpers);
  };
}
