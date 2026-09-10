import { cleanup, render, screen, within } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';

import { UserMessageContent } from '@deepagents/react-genai';

test('upload receipts render as one thumbnail strip above the original text', () => {
  const uploads = Array.from({ length: 5 }, (_, index) => ({
    path: `/workspace/.uploads/s1/shot-${index}.png`,
    name: `shot-${index}.png`,
    mediaType: 'image/png',
    size: 4,
    url: `https://uploads.test/s1/shot-${index}.png`,
  }));
  const message: UIMessage = {
    id: 'u4',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] describe those images',
      },
    ],
    metadata: { factory: { kind: 'assistant' }, uploads },
  };
  try {
    const { container } = render(<UserMessageContent message={message} />);

    const strip = screen.getByRole('list', { name: 'Attached files' });
    expect(strip).toHaveClass('flex', 'overflow-x-auto');
    expect(within(strip).getAllByRole('listitem')).toHaveLength(5);
    const firstImage = screen.getByRole('img', { name: 'shot-0.png' });
    expect(firstImage).toHaveAttribute(
      'src',
      'https://uploads.test/s1/shot-0.png',
    );
    expect(firstImage.closest('[data-variant="image"]')).toHaveClass(
      'size-36',
      'rounded-2xl',
    );
    expect(container).toHaveTextContent('describe those images');
    expect(container).toHaveTextContent(
      '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] describe those images',
    );
    expect(
      screen
        .getByText(/\[Image #1\].*describe those images/)
        .closest('.bg-secondary'),
    ).not.toBeNull();
    expect(strip.closest('.bg-secondary')).toBeNull();
  } finally {
    cleanup();
  }
});

test('video and audio receipts render as playable tiles beside image thumbnails', () => {
  const receipt = (name: string, mediaType: string) => ({
    path: `/workspace/.uploads/s1/${name}`,
    name,
    mediaType,
    size: 4,
    url: `https://uploads.test/s1/${name}`,
  });
  const message: UIMessage = {
    id: 'u6',
    role: 'user',
    parts: [
      { type: 'text', text: '[Image #1] [Video #2] [Audio #3] make reels' },
    ],
    metadata: {
      uploads: [
        receipt('still.png', 'image/png'),
        receipt('clip.mov', 'video/quicktime'),
        receipt('track.mp3', 'audio/mpeg'),
      ],
    },
  };
  try {
    render(<UserMessageContent message={message} />);

    const strip = screen.getByRole('list', { name: 'Attached files' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'still.png' })).toHaveAttribute(
      'src',
      'https://uploads.test/s1/still.png',
    );
    const video = within(strip).getByTitle('clip.mov').querySelector('video');
    expect(video).toHaveAttribute('src', 'https://uploads.test/s1/clip.mov');
    expect(video).toHaveAttribute('preload', 'metadata');
    const audio = within(strip).getByTitle('track.mp3');
    expect(audio).toHaveTextContent('track.mp3');
    expect(audio).toHaveTextContent('audio/mpeg');
    expect(audio.querySelector('video, img')).toBeNull();
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
