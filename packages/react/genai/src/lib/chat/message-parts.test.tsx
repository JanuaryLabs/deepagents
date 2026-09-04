import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';

import { UserMessageContent } from '@deepagents/react-genai';

test('an image file part renders as an image named by its filename', () => {
  const message: UIMessage = {
    id: 'u1',
    role: 'user',
    parts: [
      {
        type: 'file',
        mediaType: 'image/png',
        filename: 'shot.png',
        url: 'https://uploads.test/s1/shot.png',
      },
      { type: 'text', text: 'What is this? [Image #1]' },
    ],
  };
  try {
    const { container } = render(<UserMessageContent message={message} />);

    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute(
      'src',
      'https://uploads.test/s1/shot.png',
    );
    expect(container.textContent).toContain('What is this?');
  } finally {
    cleanup();
  }
});

test('an image file part without a filename still has an accessible name', () => {
  const message: UIMessage = {
    id: 'u2',
    role: 'user',
    parts: [
      { type: 'file', mediaType: 'image/webp', url: 'data:image/webp;base64,' },
    ],
  };
  try {
    render(<UserMessageContent message={message} />);

    expect(
      screen.getByRole('img', { name: 'Attached image' }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a non-image file part keeps the file chip', () => {
  const message: UIMessage = {
    id: 'u3',
    role: 'user',
    parts: [
      {
        type: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        url: 'data:text/plain;base64,bm90ZQ==',
      },
    ],
  };
  try {
    render(<UserMessageContent message={message} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/note\.txt/)).toHaveTextContent('(text/plain)');
  } finally {
    cleanup();
  }
});

test('upload receipts in the metadata render as images named by their filename, above the text', () => {
  const receipt = {
    path: '/workspace/.uploads/s1/shot.png',
    name: 'shot.png',
    mediaType: 'image/png',
    size: 4,
    url: 'https://uploads.test/s1/shot.png',
  };
  const message: UIMessage = {
    id: 'u4',
    role: 'user',
    parts: [{ type: 'text', text: 'What is this? [Image #1]' }],
    metadata: { factory: { kind: 'assistant' }, uploads: [receipt] },
  };
  try {
    const { container } = render(<UserMessageContent message={message} />);

    const image = screen.getByRole('img', { name: 'shot.png' });
    expect(image).toHaveAttribute('src', 'https://uploads.test/s1/shot.png');
    expect(image.parentElement?.firstElementChild).toBe(image);
    expect(container.textContent).toContain('What is this?');
  } finally {
    cleanup();
  }
});

test('malformed upload metadata renders no image', () => {
  const message: UIMessage = {
    id: 'u5',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
    metadata: { uploads: [{ url: 'https://uploads.test/s1/shot.png' }] },
  };
  try {
    render(<UserMessageContent message={message} />);

    expect(screen.queryByRole('img')).toBeNull();
  } finally {
    cleanup();
  }
});
