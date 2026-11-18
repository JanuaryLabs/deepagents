import { expect, it, vi } from 'vitest';

import { loadRuntime, queryClient } from '../app/runtime-data.ts';

it('loads discovery from the host-configured protocol mount', async ({
  signal,
}) => {
  const configuration = document.createElement('meta');
  configuration.name = 'deepagents-zukhruf-info';
  configuration.content = '/custom/zukhruf/info';
  document.head.append(configuration);
  try {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          capabilities: {
            chat: { href: '/custom/zukhruf/session' },
            history: { href: '/custom/zukhruf/history' },
            events: { href: '/custom/zukhruf/events' },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', request);

    await loadRuntime(signal);

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/custom/zukhruf/info',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } finally {
    configuration.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});
