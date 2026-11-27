import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  GenaiMessagesProvider,
  useSubmitErrorMessage,
} from '@deepagents/react-genai';
import { Composer } from '@deepagents/react-input/browser';

const ar = {
  'composer.sendFailed': 'تعذّر إرسال الطلب',
  'composer.uploadTooLarge': 'الملف أكبر من أن يُرفع.',
  'composer.uploadUnsupported': 'لا يمكن رفع هذا النوع من الملفات.',
  'composer.uploadFailed': 'تعذّر رفع الملف. حاول مجددًا.',
};

function refusedUpload(statusCode: number) {
  return new APICallError({
    message: `Upload refused with ${statusCode}`,
    url: 'https://example.test/sessions/chat-1/uploads',
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: 'refused' }),
  });
}

function EntryPageComposer({ error }: { error: Error }) {
  return (
    <Composer.Root
      editorAriaLabel="اسأل"
      submitFailedMessage="فشل"
      submitErrorMessage={useSubmitErrorMessage()}
      unsupportedFileMessage={() => 'ملف غير مدعوم'}
      unknownCommandMessage={() => 'أمر غير معروف'}
      attachmentLabel={({ number }) => `صورة ${number}`}
      pastedTextLabel={({ chars }) => `نص ${chars}`}
      missingAttachmentMessage={({ label }) => `مفقود ${label}`}
      onSubmit={() => Promise.reject(error)}
    >
      <Composer.Content>
        <Composer.Editor placeholder="اسأل أي شيء" />
        <Composer.Error />
      </Composer.Content>
    </Composer.Root>
  );
}

describe('useSubmitErrorMessage on an entry page with no chat', () => {
  it.each([
    {
      name: 'an upload refused with 413',
      error: refusedUpload(413),
      sentence: ar['composer.uploadTooLarge'],
    },
    {
      name: 'an upload refused with 415',
      error: refusedUpload(415),
      sentence: ar['composer.uploadUnsupported'],
    },
    {
      name: 'an upload refused with 500',
      error: refusedUpload(500),
      sentence: ar['composer.uploadFailed'],
    },
    {
      name: 'an Error that is no APICallError',
      error: new Error('The chat changed before the submission was sent.'),
      sentence: ar['composer.sendFailed'],
    },
  ])(
    "gives Composer.Root the catalog's sentence for $name",
    async ({ error, sentence }) => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      render(
        <ClockProvider clock={createClock()}>
          <GenaiMessagesProvider locale="ar" messages={ar}>
            <EntryPageComposer error={error} />
          </GenaiMessagesProvider>
        </ClockProvider>,
      );
      const user = userEvent.setup();

      await user.click(screen.getByRole('textbox', { name: 'اسأل' }));
      await user.keyboard('مرحبا{Enter}');

      expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    },
  );
});
