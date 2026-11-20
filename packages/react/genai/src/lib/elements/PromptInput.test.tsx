import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PromptInput, PromptInputProvider } from './PromptInput.tsx';

function stubObjectUrls() {
  const revoked: string[] = [];
  let created = 0;
  URL.createObjectURL = () => `blob:attachment-${++created}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    revoked,
    [Symbol.dispose]() {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    },
  };
}

describe('PromptInput attachments', () => {
  it('revokes the blob URL of every attached file when it unmounts', async () => {
    using urls = stubObjectUrls();
    const user = userEvent.setup();
    const { unmount } = render(<PromptInput multiple onSubmit={vi.fn()} />);

    await user.upload(screen.getByLabelText('Upload files'), [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]);
    unmount();

    expect(urls.revoked).toEqual(['blob:attachment-1', 'blob:attachment-2']);
  });

  it('revokes the blob URL of every file attached through the provider when the provider unmounts', async () => {
    using urls = stubObjectUrls();
    const user = userEvent.setup();
    const { unmount } = render(
      <PromptInputProvider>
        <PromptInput onSubmit={vi.fn()} />
      </PromptInputProvider>,
    );

    await user.upload(screen.getByLabelText('Upload files'), [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
    ]);
    unmount();

    expect(urls.revoked).toEqual(['blob:attachment-1']);
  });
});
