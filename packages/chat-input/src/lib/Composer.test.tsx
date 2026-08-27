import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  Composer,
  type ComposerDraftSource,
  type ComposerInitialDraft,
  type ComposerItem,
  type ComposerItemEntry,
  type ComposerPreparedPayload,
  type ComposerState,
  type ComposerSubmission,
  createComposerState,
  createDraftFromPersistedText,
  createDraftFromSource,
  createDraftFromState,
  mergeComposerDraftsForRestore,
  prepareComposerPayload,
  useComposer,
} from '@deepagents/chat-input/browser';

const COMMAND_TRIGGERS = ['/'];

const SLASH_COMMANDS = [
  {
    trigger: '/',
    id: 'cmd-review',
    value: 'review',
    atomic: false,
    label: 'Review',
    detail: 'Review the current prompt',
    aliases: ['inspect'],
    searchTerms: ['code review'],
    supportsArgs: true,
  },
  {
    trigger: '/',
    id: 'cmd-plan',
    value: 'plan',
    atomic: false,
    label: 'Plan',
    detail: 'Enter planning mode',
    supportsArgs: true,
  },
  {
    trigger: '/',
    id: 'cmd-diff',
    value: 'diff',
    atomic: false,
    label: 'Diff',
    detail: 'Show the current diff',
  },
  {
    trigger: '/',
    id: 'cmd-skills',
    value: 'skills',
    atomic: false,
    label: 'Skills',
    detail: 'Open skills',
  },
  {
    trigger: '/',
    id: 'cmd-debug',
    value: 'debug',
    atomic: false,
    label: 'Debug',
    detail: 'Hidden debug command',
    visibility: 'hidden' as const,
  },
  {
    trigger: '/',
    id: 'cmd-labs',
    value: 'labs',
    atomic: false,
    label: 'Labs',
    detail: 'Disabled experimental command',
    availability: 'disabled' as const,
  },
];

const MENTION_CANDIDATES = [
  {
    id: 'plugin-frontend',
    trigger: '@',
    value: 'frontend',
    label: 'frontend',
    atomic: true,
    detail: 'plugin',
    payload: { path: 'plugin://frontend', type: 'plugin' },
  },
  {
    id: 'skill-react-test',
    trigger: '$',
    value: 'react-test',
    label: 'react-test',
    atomic: true,
    detail: 'skill',
    persistsAs: '[$react-test](skill://react-test)',
    payload: {
      path: 'skill:///Users/ezzabuzaid/.agents/skills/react-test/SKILL.md',
      type: 'skill',
    },
  },
  {
    id: 'app-dashboards',
    trigger: '@',
    value: 'dashboards',
    label: 'dashboards',
    atomic: true,
    detail: 'app',
    payload: { path: 'app://dashboards', type: 'app' },
  },
  {
    id: 'file-layout',
    trigger: '@',
    value: 'apps/frontend/src/app/routes/Layout.tsx',
    label: 'apps/frontend/src/app/routes/Layout.tsx',
    atomic: true,
    detail: 'file',
    payload: {
      path: 'file://apps/frontend/src/app/routes/Layout.tsx',
      type: 'file',
    },
  },
];

const LARGE_PASTE = Array.from(
  { length: 32 },
  (_, index) =>
    `-- batch ${index + 1}
CREATE TABLE invoices (
  id uuid primary key,
  status text not null,
  total_cents integer not null
);

SELECT status, sum(total_cents) FROM invoices GROUP BY status;`,
).join('\n\n');

const REMOTE_IMAGE_URL = 'https://example.test/chart.png';
const LOCAL_IMAGE_PATH = '/tmp/composer-rich-image.png';

function registryTriggers({
  slashCommands = SLASH_COMMANDS,
  mentionCandidates = MENTION_CANDIDATES,
}: {
  slashCommands?: ComposerItemEntry[];
  mentionCandidates?: ComposerItemEntry[];
} = {}) {
  return [
    <Composer.Trigger key="slash" trigger="/">
      {slashCommands.map((command) => (
        <Composer.Command key={command.id} {...command} />
      ))}
    </Composer.Trigger>,
    ...mentionCandidates.map((candidate) => (
      <Composer.Trigger key={candidate.id} trigger={candidate.trigger}>
        <Composer.Mention {...candidate} />
      </Composer.Trigger>
    )),
  ];
}

function draftFromState(state: ComposerState): ComposerInitialDraft {
  return {
    text: state.text,
    elements: state.elements,
    mentionBindings: state.mentionBindings,
    localImages: state.localImages,
    remoteImages: state.remoteImages,
    pendingPastes: state.pendingPastes,
  };
}

function stateFromPersistedPrompt(text: string) {
  return createComposerState({
    commandTriggers: COMMAND_TRIGGERS,
    initialDraft: createDraftFromPersistedText({
      text,
      slashCommands: SLASH_COMMANDS,
      commandTriggers: COMMAND_TRIGGERS,
      mentionCandidates: MENTION_CANDIDATES,
    }),
    slashCommands: SLASH_COMMANDS,
    mentionCandidates: MENTION_CANDIDATES,
  });
}

function renderRichInput(
  options: {
    disabled?: boolean;
    initialText?: string;
    initialState?: ComposerState;
    initialRemoteImageUrls?: string[];
    mentionCandidates?: ComposerItemEntry[];
    slashCommands?: ComposerItemEntry[];
    isTaskRunning?: boolean;
    maxExpandedTextChars?: number;
  } = {},
) {
  const user = userEvent.setup();
  render(<RichInputScenario {...options} />);
  return {
    user,
    prompt: screen.getByRole<HTMLElement>('textbox', {
      name: /rich prompt composer/i,
    }),
    submissions: () => screen.getByRole('region', { name: /submission log/i }),
  };
}

function RichInputScenario({
  disabled = false,
  initialText = '',
  initialState: providedInitialState,
  initialRemoteImageUrls,
  mentionCandidates = MENTION_CANDIDATES,
  slashCommands = SLASH_COMMANDS,
  isTaskRunning = false,
  maxExpandedTextChars,
}: {
  disabled?: boolean;
  initialText?: string;
  initialState?: ComposerState;
  initialRemoteImageUrls?: string[];
  mentionCandidates?: ComposerItemEntry[];
  slashCommands?: ComposerItemEntry[];
  isTaskRunning?: boolean;
  maxExpandedTextChars?: number;
}) {
  const [running, setRunning] = useState(isTaskRunning);
  const initialState =
    providedInitialState ??
    createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text: initialText,
      slashCommands,
      mentionCandidates,
      remoteImageUrls: initialRemoteImageUrls,
    });
  const [submissions, setSubmissions] = useState<ComposerSubmission[]>([]);
  const [snapshot, setSnapshot] = useState<{
    state: ComposerState;
    prepared: ComposerPreparedPayload;
  }>({
    state: initialState,
    prepared: prepareComposerPayload(
      initialState,
      slashCommands,
      COMMAND_TRIGGERS,
    ),
  });

  return (
    <>
      <Composer.Root
        initialDraft={draftFromState(initialState)}
        disabled={disabled}
        isTaskRunning={running}
        maxExpandedTextChars={maxExpandedTextChars}
        onStateChange={(state, prepared) => setSnapshot({ state, prepared })}
        onSubmit={(submission) =>
          setSubmissions((current) => [submission, ...current])
        }
      >
        {registryTriggers({ slashCommands, mentionCandidates })}
        <Composer.Popup />
        <Composer.Content>
          <Composer.Toolbar>
            <Composer.AttachLocalImage path={LOCAL_IMAGE_PATH}>
              Attach local image
            </Composer.AttachLocalImage>
            <Composer.AddRemoteImage url={REMOTE_IMAGE_URL}>
              Add remote image
            </Composer.AddRemoteImage>
            <Composer.InsertPaste content={LARGE_PASTE}>
              Insert large paste
            </Composer.InsertPaste>
            <Composer.InsertRichLink
              href="https://github.com/openai/composer"
              label="openai/composer"
              metadata={{
                title: 'OpenAI Composer',
                description: 'Open-source coding agent',
                siteName: 'GitHub',
                domain: 'github.com',
              }}
            >
              Insert rich link
            </Composer.InsertRichLink>
            <Composer.Submit>Submit prompt</Composer.Submit>
            <Composer.Reset>Reset rich prompt</Composer.Reset>
          </Composer.Toolbar>
          <Composer.RemoteImages />
          <Composer.Editor />
          <Composer.Error />
        </Composer.Content>
        <Composer.Shortcuts />
        <Composer.Footer />
      </Composer.Root>
      <button type="button" onClick={() => setRunning((current) => !current)}>
        Toggle running
      </button>
      <SubmissionLog submissions={submissions} />
      <section aria-label="Rich composer snapshot">
        <p>Draft: {snapshot.state.text}</p>
        <p>
          Prepared:{' '}
          {snapshot.prepared
            ? `${snapshot.prepared.mode}:${snapshot.prepared.persistedPrompt}`
            : 'empty'}
        </p>
      </section>
    </>
  );
}

function QueuedRichRestoreScenario() {
  const [draft, setDraft] = useState<ComposerInitialDraft>({ text: '' });
  const [revision, setRevision] = useState(0);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('');
  const [queuedDrafts, setQueuedDrafts] = useState<
    { id: string; source: ComposerDraftSource }[]
  >([]);
  const [snapshot, setSnapshot] = useState<ComposerState>(() =>
    createComposerState({
      slashCommands: SLASH_COMMANDS,
      commandTriggers: COMMAND_TRIGGERS,
    }),
  );

  const restoreDraft = (nextDraft: ComposerInitialDraft) => {
    setDraft(nextDraft);
    setRevision((current) => current + 1);
  };
  const editLatestQueued = () => {
    const latest = queuedDrafts[queuedDrafts.length - 1];
    if (!latest) {
      return;
    }
    setLastSubmittedPrompt('');
    setQueuedDrafts((current) => current.slice(0, -1));
    restoreDraft(
      createDraftFromSource({
        source: latest.source,
        slashCommands: SLASH_COMMANDS,
        mentionCandidates: MENTION_CANDIDATES,
      }),
    );
  };
  const interruptRestore = () => {
    restoreDraft(
      mergeComposerDraftsForRestore([
        ...queuedDrafts.map((entry) =>
          createDraftFromSource({
            source: entry.source,
            slashCommands: SLASH_COMMANDS,
            mentionCandidates: MENTION_CANDIDATES,
          }),
        ),
        createDraftFromState(snapshot),
      ]),
    );
    setQueuedDrafts([]);
  };

  return (
    <>
      <Composer.Root
        key={revision}
        initialDraft={draft}
        isTaskRunning
        onStateChange={(state) => setSnapshot(state)}
        onSubmit={(submission, context) => {
          setLastSubmittedPrompt(submission.prompt);
          if (submission.mode === 'queued') {
            setQueuedDrafts((current) => [
              ...current,
              {
                id: submission.id,
                source: context.editableSource,
              },
            ]);
          }
        }}
      >
        {registryTriggers()}
        <Composer.Popup />
        <Composer.Content>
          <Composer.Editor />
          <Composer.InsertPaste content={LARGE_PASTE}>
            Insert queued paste
          </Composer.InsertPaste>
        </Composer.Content>
        <Composer.Shortcuts />
        <Composer.Footer />
      </Composer.Root>
      <button type="button" onClick={editLatestQueued}>
        Edit latest rich queued
      </button>
      <button type="button" onClick={interruptRestore}>
        Interrupt rich restore
      </button>
      <output aria-label="rich queued count">{queuedDrafts.length}</output>
      <output aria-label="rich queued drafts">
        {queuedDrafts.map((entry) => entry.source.persistedPrompt).join('|')}
      </output>
      <output aria-label="rich restored text">{snapshot.text}</output>
      <output aria-label="rich restored elements">
        {snapshot.elements
          .map((element) => `${element.kind}:${element.label}`)
          .join('|')}
      </output>
      <output aria-label="rich submitted prompt">{lastSubmittedPrompt}</output>
    </>
  );
}

function RichCompoundActionScenario() {
  const initialState = createComposerState({
    commandTriggers: COMMAND_TRIGGERS,
    text: 'compound prompt',
    slashCommands: SLASH_COMMANDS,
    mentionCandidates: MENTION_CANDIDATES,
  });
  const [lastClick, setLastClick] = useState('none');
  const [submissions, setSubmissions] = useState<ComposerSubmission[]>([]);

  return (
    <>
      <Composer.Root
        initialDraft={draftFromState(initialState)}
        onSubmit={(submission) =>
          setSubmissions((current) => [submission, ...current])
        }
      >
        {registryTriggers()}
        <Composer.Popup />
        <Composer.Content>
          <Composer.Editor />
        </Composer.Content>
        <Composer.Submit
          asChild
          onClick={(event) => {
            event.preventDefault();
            setLastClick('blocked');
          }}
        >
          <button type="button">Blocked rich child submit</button>
        </Composer.Submit>
        <Composer.Submit asChild onClick={() => setLastClick('allowed')}>
          <button type="button">Allowed rich child submit</button>
        </Composer.Submit>
      </Composer.Root>
      <p>Last rich child click: {lastClick}</p>
      <SubmissionLog submissions={submissions} />
    </>
  );
}

function RichDisabledAnchorActionScenario() {
  const initialState = createComposerState({
    commandTriggers: COMMAND_TRIGGERS,
    text: 'disabled rich prompt',
    slashCommands: SLASH_COMMANDS,
    mentionCandidates: MENTION_CANDIDATES,
  });
  const [submissions, setSubmissions] = useState<ComposerSubmission[]>([]);

  return (
    <>
      <Composer.Root
        initialDraft={draftFromState(initialState)}
        disabled
        onSubmit={(submission) =>
          setSubmissions((current) => [submission, ...current])
        }
      >
        {registryTriggers()}
        <Composer.Popup />
        <Composer.Content>
          <Composer.Editor />
        </Composer.Content>
        <Composer.Submit asChild>
          <a href="/submit">Disabled rich anchor submit</a>
        </Composer.Submit>
      </Composer.Root>
      <SubmissionLog submissions={submissions} />
    </>
  );
}

function RichContextConsumerScenario() {
  const initialState = createComposerState({
    commandTriggers: COMMAND_TRIGGERS,
    text: 'rich context prompt',
    slashCommands: SLASH_COMMANDS,
    mentionCandidates: MENTION_CANDIDATES,
  });
  const [submissions, setSubmissions] = useState<ComposerSubmission[]>([]);

  return (
    <>
      <Composer.Root
        initialDraft={draftFromState(initialState)}
        onSubmit={(submission) =>
          setSubmissions((current) => [submission, ...current])
        }
      >
        {registryTriggers()}
        <Composer.Popup />
        <Composer.Content>
          <Composer.Editor />
        </Composer.Content>
        <RichContextConsumer />
      </Composer.Root>
      <SubmissionLog submissions={submissions} />
    </>
  );
}

function RichCustomPopupScenario() {
  const initialState = createComposerState({
    commandTriggers: COMMAND_TRIGGERS,
    slashCommands: SLASH_COMMANDS,
    mentionCandidates: MENTION_CANDIDATES,
  });
  const [submissions, setSubmissions] = useState<ComposerSubmission[]>([]);

  return (
    <>
      <Composer.Root
        initialDraft={draftFromState(initialState)}
        onSubmit={(submission) =>
          setSubmissions((current) => [submission, ...current])
        }
      >
        {registryTriggers()}
        <Composer.Content>
          <Composer.Editor />
        </Composer.Content>
        <RichSlashToggle />
        <RichCustomPopup />
      </Composer.Root>
      <SubmissionLog submissions={submissions} />
    </>
  );
}

function RichContextConsumer() {
  const { state, actions, meta } = useComposer('RichContextConsumer');
  return (
    <section aria-label="Rich context consumer">
      <p>Context draft: {state.text}</p>
      <p>Context disabled: {String(meta.disabled)}</p>
      <button type="button" onClick={actions.submit}>
        Rich context submit
      </button>
    </section>
  );
}

function RichCustomPopup() {
  const { actions, meta } = useComposer('RichCustomPopup');
  if (!meta.activePopup) {
    return <p>No custom rich popup</p>;
  }
  return (
    <section aria-label="Rich custom popup">
      {meta.suggestions.map((suggestion, index) => (
        <button
          key={`item:${suggestion.id}`}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            actions.acceptSuggestion({ index });
          }}
        >
          Custom {`${suggestion.trigger}${suggestion.value}`}
        </button>
      ))}
    </section>
  );
}

function RichSlashToggle() {
  const { actions } = useComposer('RichSlashToggle');
  return (
    <button type="button" onClick={actions.toggleSlashMenu}>
      Toggle rich suggestions
    </button>
  );
}

function SubmissionLog({ submissions }: { submissions: ComposerSubmission[] }) {
  return (
    <section aria-label="Submission log">
      {submissions.length === 0 ? (
        <p>No submissions</p>
      ) : (
        submissions.map((submission, index) => (
          <article aria-label={`Submission ${index + 1}`} key={submission.id}>
            <p>Mode: {submission.mode}</p>
            <p>Action: {submission.action}</p>
            <p>Command: {submission.command ?? 'none'}</p>
            <p>Args: {submission.args ?? 'none'}</p>
            <p>Text: {submission.persistedPrompt || 'empty'}</p>
            <p>Expanded: {submission.prompt || 'empty'}</p>
            <ul aria-label="Submission items">
              {submission.items.map((item, itemIndex) => (
                <li key={`${item.type}-${itemIndex}`}>
                  {formatSubmissionItem(item)}
                </li>
              ))}
            </ul>
          </article>
        ))
      )}
    </section>
  );
}

function formatSubmissionItem(item: ComposerSubmission['items'][number]) {
  if (item.type === 'text') {
    return `text:${item.text}`;
  }
  if (item.type === 'local_image') {
    return `local_image:${item.path}`;
  }
  if (item.type === 'remote_image') {
    return `remote_image:${item.url}`;
  }
  if (item.type === 'link') {
    return `link:${item.text}:${item.href}`;
  }
  if (item.type === 'rich_link') {
    return `rich_link:${item.text}:${item.href}:${item.metadata?.title ?? ''}`;
  }
  return `${item.type}:${item.trigger}${item.value}`;
}

describe('Composer compound API', () => {
  it('throws a component-specific error when a compound consumer is rendered outside Root', () => {
    expect(() => render(<OrphanRichConsumer />)).toThrow(
      'OrphanRichConsumer must be used inside Composer.Root.',
    );
  });

  it('renders action triggers as non-submit buttons by default', () => {
    renderRichInput();

    expect(
      screen.getByRole('button', { name: /submit prompt/i }),
    ).toHaveAttribute('type', 'button');
  });

  it('labels the editor with the default aria-label and auto direction', async () => {
    render(
      <Composer.Root>
        <Composer.Editor />
      </Composer.Root>,
    );

    const prompt = await screen.findByRole('textbox', {
      name: /rich prompt composer/i,
    });
    expect(prompt).toHaveAttribute('dir', 'auto');
  });

  it('labels the editor from editorAriaLabel', async () => {
    render(
      <Composer.Root editorAriaLabel="Message">
        <Composer.Editor />
      </Composer.Root>,
    );

    expect(
      await screen.findByRole('textbox', { name: 'Message' }),
    ).toBeInTheDocument();
  });

  it('supports asChild action triggers while honoring prevented child clicks', async () => {
    const user = userEvent.setup();
    render(<RichCompoundActionScenario />);

    await user.click(
      screen.getByRole('button', { name: /blocked rich child submit/i }),
    );

    expect(
      screen.getByText(/last rich child click: blocked/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('No submissions');

    await user.click(
      screen.getByRole('button', { name: /allowed rich child submit/i }),
    );

    expect(
      screen.getByText(/last rich child click: allowed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('Text: compound prompt');
  });

  it('marks disabled asChild actions without leaking native disabled onto non-buttons', async () => {
    const user = userEvent.setup();
    render(<RichDisabledAnchorActionScenario />);

    const submit = screen.getByRole('link', {
      name: /disabled rich anchor submit/i,
    });

    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit).not.toHaveAttribute('disabled');

    await user.click(submit);

    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('No submissions');
  });

  it('exposes state, actions, and meta to custom compound children', async () => {
    const user = userEvent.setup();
    render(<RichContextConsumerScenario />);

    expect(
      screen.getByRole('region', { name: /rich context consumer/i }),
    ).toHaveTextContent('Context draft: rich context prompt');
    expect(
      screen.getByRole('region', { name: /rich context consumer/i }),
    ).toHaveTextContent('Context disabled: false');

    await user.click(
      screen.getByRole('button', { name: /rich context submit/i }),
    );

    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('Text: rich context prompt');
  });

  it('lets custom popup children accept a non-highlighted slash suggestion by index', async () => {
    const user = userEvent.setup();
    render(<RichCustomPopupScenario />);

    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });
    await user.click(prompt);
    await user.keyboard('/');

    await user.click(
      await screen.findByRole('button', { name: /custom \/diff/i }),
    );

    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('No submissions');
    expect(prompt).toHaveTextContent('/diff');
  });

  it('lets custom popup children accept a non-highlighted mention suggestion by index', async () => {
    const user = userEvent.setup();
    render(<RichCustomPopupScenario />);

    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });
    await user.click(prompt);
    await user.keyboard('inspect @');

    await user.click(
      await screen.findByRole('button', { name: /custom @dashboards/i }),
    );
    await user.keyboard('soon');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /submission log/i }),
      ).toHaveTextContent('Text: inspect @dashboards soon');
    });
    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('item:@dashboards');
  });
});

function OrphanRichConsumer() {
  useComposer('OrphanRichConsumer');
  return null;
}

describe('Composer empty prompt', () => {
  it.each([
    ['Enter', '{Enter}'],
    ['Tab', '{Tab}'],
  ])('ignores %s when there is no prompt content', async (_name, key) => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard(key);

    expect(submissions()).toHaveTextContent('No submissions');
    const snapshot = screen.getByRole('region', {
      name: /rich composer snapshot/i,
    });
    expect(snapshot.textContent).toContain('Draft: ');
    expect(snapshot.textContent).toContain('Prepared: empty');
  });

  it('toggles keyboard shortcuts with ? only while the draft is empty', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: '?', code: 'Slash', shiftKey: true });

    expect(
      screen.getByRole('dialog', { name: /keyboard shortcuts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: ');

    fireEditorKeyDown(prompt, { key: '?', code: 'Slash', shiftKey: true });

    expect(
      screen.queryByRole('dialog', { name: /keyboard shortcuts/i }),
    ).not.toBeInTheDocument();

    await user.keyboard('alpha?');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: alpha?');
    });
    expect(
      screen.queryByRole('dialog', { name: /keyboard shortcuts/i }),
    ).not.toBeInTheDocument();
  });

  it('inserts a newline with Shift+Enter and submits multiline text with Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.keyboard('beta');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha\nbeta');
    });
    await user.keyboard('{Enter}');

    const latestSubmission = screen.getByRole('article', {
      name: /submission 1/i,
    });
    expect(latestSubmission.textContent).toContain('Text: alpha\nbeta');
    expect(latestSubmission.textContent).toContain('Expanded: alpha\nbeta');
  });

  it.each([
    ['Alt+Enter', { key: 'Enter', code: 'Enter', altKey: true }],
    ['Ctrl+J', { key: 'j', code: 'KeyJ', ctrlKey: true }],
    ['Ctrl+M', { key: 'm', code: 'KeyM', ctrlKey: true }],
  ])(
    'inserts a newline with %s and submits multiline text with Enter',
    async (_shortcut, keyEvent) => {
      const { user, prompt, submissions } = renderRichInput();

      await user.click(prompt);
      await user.keyboard('alpha');
      fireEditorKeyDown(prompt, keyEvent);

      await waitFor(() => {
        expect(
          screen.getByRole('region', { name: /rich composer snapshot/i })
            .textContent,
        ).toContain('Draft: alpha\n');
      });
      expect(submissions()).toHaveTextContent('No submissions');

      await user.keyboard('beta');
      await waitFor(() => {
        expect(
          screen.getByRole('region', { name: /rich composer snapshot/i })
            .textContent,
        ).toContain('Draft: alpha\nbeta');
      });
      await user.keyboard('{Enter}');

      const latestSubmission = screen.getByRole('article', {
        name: /submission 1/i,
      });
      expect(latestSubmission.textContent).toContain('Text: alpha\nbeta');
      expect(latestSubmission.textContent).toContain('Expanded: alpha\nbeta');
    },
  );

  it('keeps a plain prompt editable when Tab is pressed while idle', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('do not submit with tab');
    await user.keyboard('{Tab}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: do not submit with tab');
  });

  it('does not submit a remote-image-only prompt on Shift+Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(prompt);
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
  });
});

describe('Composer slash and mention behavior', () => {
  it('parses Composer custom prompt names with their prompts namespace', () => {
    const slashCommands = [
      {
        trigger: '/',
        id: 'cmd-prompts-recent',
        value: 'prompts:recent',
        atomic: false,
        label: 'Recent',
        detail: 'List recent chats',
        supportsArgs: true,
        expandsTo: 'List the latest conversations.',
      },
    ];
    const state = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text: '/prompts:recent from today',
      slashCommands,
    });

    expect(
      prepareComposerPayload(state, slashCommands, COMMAND_TRIGGERS),
    ).toMatchObject({
      mode: 'command-with-args',
      command: 'prompts:recent',
      args: 'from today',
      prompt: 'List the latest conversations.\n\nfrom today',
      persistedPrompt: '/prompts:recent from today',
      historyPrompt: 'List the latest conversations.\n\nfrom today',
    });
  });

  it('expands a custom prompt before submission and stores that snapshot in history', async () => {
    const slashCommands = [
      {
        trigger: '/',
        id: 'cmd-prompts-recent',
        value: 'prompts:recent',
        atomic: false,
        label: 'Recent',
        detail: 'List recent chats',
        supportsArgs: true,
        expandsTo: 'List the latest conversations.',
      },
    ];
    const { user, prompt, submissions } = renderRichInput({ slashCommands });

    await user.click(prompt);
    await user.keyboard('/prompts:recent from today');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('Text: /prompts:recent from today');
    expect(submissions()).toHaveTextContent(
      'Expanded: List the latest conversations. from today',
    );

    await user.click(prompt);
    await user.keyboard('working draft');
    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: List the latest conversations. from today');
    });
  });

  it('offers slash commands after words and keeps the completed token editable', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('hello /pla');

    await waitFor(() => {
      expect(prompt).toHaveTextContent('hello /pla');
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/plan',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: hello /plan');
    });

    await user.keyboard('now');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent('Text: hello /plan now');
  });

  it('offers slash commands after a newline', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first line{Shift>}{Enter}{/Shift}/pla');

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/plan',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s*\/plan/);
    });
  });

  it('moves slash suggestions with Ctrl+N before completing the selected command', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Control>}n{/Control}');
    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: /plan ');
    });
  });

  it('moves slash suggestions with ArrowDown before completing the selected command', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /plan ');
  });

  it('scrolls the keyboard-selected suggestion into view', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const { user, prompt } = renderRichInput();

      await user.click(prompt);
      await user.keyboard('/');
      await screen.findByRole('listbox', {
        name: /suggestions/i,
      });
      scrollIntoView.mockClear();

      await user.keyboard('{ArrowDown}');

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('completes the clicked slash suggestion instead of the highlighted one', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.click(
      within(screen.getByRole('listbox', { name: /suggestions/i })).getByRole(
        'option',
        { name: /\/diff item/i },
      ),
    );

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /diff ');
  });

  it('hides hidden and disabled slash commands from suggestions', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    const listbox = screen.getByRole('listbox', {
      name: /suggestions/i,
    });
    expect(within(listbox).getByText('/review')).toBeInTheDocument();
    expect(within(listbox).queryByText('/debug')).not.toBeInTheDocument();
    expect(within(listbox).queryByText('/labs')).not.toBeInTheDocument();
  });

  it('matches slash aliases and completes the canonical command', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/inspect');
    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/review',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /review ');
  });

  it('matches slash search terms and completes the canonical command', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/code');
    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/review',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: /review ');
    });
  });

  it('runs hidden slash commands only when typed explicitly', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/debug');

    expect(
      screen.queryByRole('listbox', { name: /suggestions/i }),
    ).not.toBeInTheDocument();

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: command');
    });
    expect(submissions()).toHaveTextContent('Command: debug');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Prepared: empty');
  });

  it('rejects disabled slash commands as unknown', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/labs');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /labs');
    expect(
      screen.getByText(/unrecognized command: \/labs/i),
    ).toBeInTheDocument();
  });

  it('dismisses the slash popup with Escape without clearing the draft', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('hello /pla');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('listbox', { name: /suggestions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: hello /pla');
  });

  it('types a second slash instead of accepting the active suggestion', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('hello /pla');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('/');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: hello /pla/');
    });
    expect(
      screen.queryByRole('listbox', { name: /suggestions/i }),
    ).not.toBeInTheDocument();
  });

  it('completes a selected leading slash command with Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/rev');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /review ');
  });

  it('submits a leading-space slash command as plain text', async () => {
    const { user, submissions } = renderRichInput({
      initialText: ' /diff',
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Mode: submitted');
    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent('Text: /diff');
  });

  it('submits a path-like leading slash as plain text', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/Users/ezzabuzaid/project');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: submitted');
    });
    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent('Text: /Users/ezzabuzaid/project');
  });

  it('submits a single-segment absolute path as plain text', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/tmp');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: submitted');
    });
    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent('Text: /tmp');
    expect(
      screen.queryByText(/unrecognized command: \/tmp/i),
    ).not.toBeInTheDocument();
  });

  it('submits slash-space text as a plain prompt', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/ diff');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: submitted');
    });
    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent('Text: / diff');
  });

  it('completes but does not run embedded slash text with Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('hello /dif');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: hello /diff ');
    });
  });

  it('inserts @ mentions anywhere and submits them as structured items', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('inspect @fro');
    await user.keyboard('{Tab}');
    await user.keyboard('soon');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('item:@frontend');
  });

  it('offers mention candidates after a newline', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first line{Shift>}{Enter}{/Shift}@fro');

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '@frontend',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s*@frontend/);
    });
  });

  it('moves mention suggestions with ArrowDown before inserting the selected candidate', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('open @');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: open @dashboards ');
    });
  });

  it('inserts the clicked mention suggestion instead of the highlighted one', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('open @');
    await user.keyboard('{ArrowDown}');

    await user.click(
      within(screen.getByRole('listbox', { name: /suggestions/i })).getByRole(
        'option',
        { name: /@frontend/i },
      ),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: open @frontend ');
    });
  });

  it('inserts $ skill mentions anywhere and submits them as skill items', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('use $react');
    await user.keyboard('{Tab}');
    await user.keyboard('here');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('item:$react-test');
  });

  it('submits an unmatched mention query as literal prompt text with Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('inspect @missing');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('Mode: submitted');
    expect(submissions()).toHaveTextContent('Text: inspect @missing');
    expect(submissions()).not.toHaveTextContent('mention:');
  });

  it('dismisses the mention popup with Escape and keeps the literal query', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('open @');
    await waitFor(() => {
      expect(
        screen.getByRole('listbox', { name: /suggestions/i }),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('listbox', { name: /suggestions/i }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: open @');

    await user.keyboard('fro now');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('Text: open @fro now');
    expect(submissions()).not.toHaveTextContent('mention:');
  });

  it('shows all matching mention kinds without scope tabs', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('open @');

    await waitFor(() => {
      const listbox = screen.getByRole('listbox', {
        name: /suggestions/i,
      });
      expect(
        within(listbox).getByText('@apps/frontend/src/app/routes/Layout.tsx'),
      ).toBeInTheDocument();
      expect(within(listbox).getByText('@frontend')).toBeInTheDocument();
      expect(within(listbox).getByText('@dashboards')).toBeInTheDocument();
      expect(
        within(listbox).queryByRole('button', {
          name: /filesystem|tools|all/i,
        }),
      ).not.toBeInTheDocument();
    });
  });

  it('refreshes an open mention popup when the host provides async candidates', async () => {
    const user = userEvent.setup();
    const withoutFileCandidates = MENTION_CANDIDATES.filter(
      (candidate) => candidate.id !== 'file-layout',
    );
    const { rerender } = render(
      <RichInputScenario mentionCandidates={withoutFileCandidates} />,
    );
    const prompt = screen.getByRole<HTMLElement>('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('open @Layout');

    const emptyListbox = screen.getByRole('listbox', {
      name: /suggestions/i,
    });
    expect(emptyListbox).toHaveTextContent('no matches');
    expect(
      within(emptyListbox).queryByText(
        '@apps/frontend/src/app/routes/Layout.tsx',
      ),
    ).not.toBeInTheDocument();

    rerender(<RichInputScenario mentionCandidates={MENTION_CANDIDATES} />);

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '@apps/frontend/src/app/routes/Layout.tsx',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');
    await user.keyboard('please');
    await user.keyboard('{Enter}');

    expect(
      screen.getByRole('region', { name: /submission log/i }),
    ).toHaveTextContent('item:@apps/frontend/src/app/routes/Layout.tsx');
  });

  it('keeps app mentions directly available from @', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('open @dash');

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '@dashboards',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Tab}');
    await user.keyboard('soon');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('item:@dashboards');
  });

  it('keeps slash commands composable while a task is running', async () => {
    const { user, prompt, submissions } = renderRichInput({
      isTaskRunning: true,
    });

    await user.click(prompt);
    await user.keyboard('/dif');

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/diff',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /diff ');
  });

  it('preserves an unknown leading slash command and shows an inline error', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/unknown inspect this patch');
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /unknown inspect this patch');
    expect(
      screen.getByText(/unrecognized command: \/unknown/i),
    ).toBeInTheDocument();
  });

  it('submits slash command args with accepted mentions as structured items', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('/review @fro');
    await user.keyboard('{Tab}');
    await user.keyboard('please');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: command-with-args');
    });
    expect(submissions()).toHaveTextContent('Command: review');
    expect(submissions()).toHaveTextContent('Args: @frontend please');
    expect(submissions()).toHaveTextContent('item:@frontend');
  });

  it('submits slash command args with expanded large paste content', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('/review ');
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: command-with-args');
    });
    expect(submissions()).toHaveTextContent('Command: review');
    expect(submissions()).toHaveTextContent('Args: -- batch 1');
    expect(submissions()).toHaveTextContent(`Text: /review ${placeholder}`);
    expect(submissions()).toHaveTextContent('CREATE TABLE invoices');
  });

  it('keeps slash commands composable after the running prop changes', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /toggle running/i }));
    await user.click(prompt);
    await user.keyboard('/dif');

    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/diff',
        ),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: /diff ');
  });
});

describe('Composer editing shortcuts', () => {
  it('replaces the whole prompt after select-all instead of inserting at the start', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('replace everything');
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('replacement');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: replacement');
    });
    expect(prompt).toHaveTextContent('replacement');
    expect(prompt).not.toHaveTextContent('replace everything');
  });

  it('replaces a structured prompt with atoms after select-all', async () => {
    const { user, prompt } = renderRichInput({
      initialText: '/review @frontend Please inspect this patch',
      initialRemoteImageUrls: [REMOTE_IMAGE_URL],
    });

    await user.click(prompt);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('replacement');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: replacement');
    });
    expect(prompt).toHaveTextContent('replacement');
    expect(prompt).not.toHaveTextContent('/review');
    expect(prompt).not.toHaveTextContent('@frontend');
  });

  it('clears the prompt after select-all delete', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('Hello');
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Delete}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: ');
    });
    expect(prompt).toHaveTextContent('');
    expect(submissions()).toHaveTextContent('No submissions');

    const selection = document.getSelection();
    expect(selection?.toString()).toBe('');
    expect(selection?.isCollapsed).toBe(true);
    expect(
      selection?.anchorNode ? prompt.contains(selection.anchorNode) : false,
    ).toBe(true);
  });

  it('kills text to the end of the line and yanks it back', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha beta gamma');
    placeCursorAfterText(prompt, 'alpha ');
    fireEditorKeyDown(prompt, { key: 'k', code: 'KeyK', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: alpha ');
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: alpha beta gamma');
    });
  });

  it('kills text to the start of the line and yanks it back', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first line{Shift>}{Enter}{/Shift}alpha beta gamma');
    placeCursorAfterText(prompt, 'alpha beta ');
    fireEditorKeyDown(prompt, { key: 'u', code: 'KeyU', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s+gamma/);
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s+alpha beta gamma/);
    });
  });

  it('moves to the end of the current line with Ctrl+E', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first line{Shift>}{Enter}{/Shift}alpha beta gamma');
    placeCursorAfterText(prompt, 'alpha ');
    await fireEditorKeyDownSettled(prompt, {
      key: 'e',
      code: 'KeyE',
      ctrlKey: true,
    });
    await user.keyboard('!');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s+alpha beta gamma!/);
    });
  });

  it('kills the previous word with Ctrl+W and yanks it back', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha beta gamma  ');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta gamma  ');
    });
    fireEditorKeyDown(prompt, { key: 'w', code: 'KeyW', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta ');
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta gamma  ');
    });
  });

  it('moves by word with Alt+B and Alt+F', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha beta gamma');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta gamma');
    });

    fireEditorKeyDown(prompt, { key: 'b', code: 'KeyB', altKey: true });
    await user.keyboard('!');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta !gamma');
    });

    fireEditorKeyDown(prompt, { key: 'f', code: 'KeyF', altKey: true });
    await user.keyboard('?');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: alpha beta !gamma?');
    });
  });

  it('yanks a backward-killed mention atom as a structured item', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('ask @fro');
    await user.keyboard('{Tab}');
    fireEditorKeyDown(prompt, { key: 'w', code: 'KeyW', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i })
          .textContent,
      ).toContain('Draft: ask ');
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('item:@frontend');
    });
    expect(submissions()).toHaveTextContent('Text: ask @frontend');
  });

  it('yanks killed structured atoms back as submission items', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('keep @fro');
    await user.keyboard('{Tab}');
    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /insert rich link/i }));
    await user.keyboard(' tail');

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent('Draft: keep @frontend');
      expect(snapshot).toHaveTextContent('[Image #1]');
      expect(snapshot).toHaveTextContent(placeholder);
      expect(snapshot).toHaveTextContent('openai/composer');
    });

    placeCursorAfterText(prompt, 'keep ');
    fireEditorKeyDown(prompt, { key: 'k', code: 'KeyK', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep ');
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent('Draft: keep @frontend');
      expect(snapshot).toHaveTextContent('[Image #1]');
      expect(snapshot).toHaveTextContent(placeholder);
      expect(snapshot).toHaveTextContent('openai/composer');
      expect(snapshot).toHaveTextContent('tail');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Text: keep @frontend');
    });
    expect(submissions()).toHaveTextContent('item:@frontend');
    expect(submissions()).toHaveTextContent(`local_image:${LOCAL_IMAGE_PATH}`);
    expect(submissions()).toHaveTextContent(
      'rich_link:openai/composer:https://github.com/openai/composer',
    );
  });

  it('yanks backward-killed structured atoms back as submission items', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('keep @fro');
    await user.keyboard('{Tab}');
    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /insert rich link/i }));
    await user.keyboard(' tail');

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent('Draft: keep @frontend');
      expect(snapshot).toHaveTextContent('[Image #1]');
      expect(snapshot).toHaveTextContent(placeholder);
      expect(snapshot).toHaveTextContent('openai/composer');
      expect(snapshot).toHaveTextContent('tail');
    });

    placeCursorBeforeText(prompt, ' tail');
    fireEditorKeyDown(prompt, { key: 'u', code: 'KeyU', ctrlKey: true });

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).not.toHaveTextContent('@frontend');
      expect(snapshot).not.toHaveTextContent('[Image #1]');
      expect(snapshot).not.toHaveTextContent(placeholder);
      expect(snapshot).toHaveTextContent('Draft: tail');
    });

    fireEditorKeyDown(prompt, { key: 'y', code: 'KeyY', ctrlKey: true });

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent('Draft: keep @frontend');
      expect(snapshot).toHaveTextContent('[Image #1]');
      expect(snapshot).toHaveTextContent(placeholder);
      expect(snapshot).toHaveTextContent('openai/composer');
      expect(snapshot).toHaveTextContent('tail');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Text: keep @frontend');
    });
    expect(submissions()).toHaveTextContent('item:@frontend');
    expect(submissions()).toHaveTextContent(`local_image:${LOCAL_IMAGE_PATH}`);
    expect(submissions()).toHaveTextContent(
      'rich_link:openai/composer:https://github.com/openai/composer',
    );
  });

  it('preserves the kill buffer after submitting and yanks into the cleared prompt', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha beta');
    placeCursorAfterText(prompt, 'alpha ');
    fireEditorKeyDown(prompt, { key: 'k', code: 'KeyK', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: alpha ');
    });

    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent('Text: alpha');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Prepared: empty');
    });

    await user.keyboard('{Control>}y{/Control}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: beta');
    });
  });

  it('preserves the kill buffer after a leading command clears the prompt', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('beta');
    placeCursorBeforeText(prompt, 'beta');
    fireEditorKeyDown(prompt, { key: 'k', code: 'KeyK', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Prepared: empty');
    });

    await user.keyboard('/diff');
    await waitFor(() => {
      expect(
        within(screen.getByRole('listbox', { name: /suggestions/i })).getByText(
          '/diff',
        ),
      ).toBeInTheDocument();
    });
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: /diff ');
    });
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: command');
    });
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Prepared: empty');
    });

    await user.keyboard('{Control>}y{/Control}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: beta');
    });
  });

  it('places the cursor at the end of restored initial text after reset', async () => {
    const { user, prompt } = renderRichInput({ initialText: 'seed' });

    await user.click(prompt);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('changed');
    await user.click(
      screen.getByRole('button', { name: /reset rich prompt/i }),
    );
    await user.keyboard('!');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: seed!');
    });
  });

  it('preserves the kill buffer across reset and yanks at the restored end', async () => {
    const { user, prompt } = renderRichInput({ initialText: 'seed ' });

    await user.click(prompt);
    await user.keyboard('beta');
    placeCursorAfterText(prompt, 'seed ');
    fireEditorKeyDown(prompt, { key: 'k', code: 'KeyK', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: seed ');
    });

    await user.click(
      screen.getByRole('button', { name: /reset rich prompt/i }),
    );
    await user.keyboard('{Control>}y{/Control}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: seed beta');
    });
  });
});

describe('Composer history behavior', () => {
  it('navigates recalled prompts with ArrowUp and ArrowDown', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('second prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: second prompt');
    });

    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: first prompt');
    });

    fireEditorKeyDown(prompt, { key: 'ArrowDown', code: 'ArrowDown' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: second prompt');
    });
  });

  it('restores the in-progress draft after recalling history with ArrowUp', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('submitted prompt');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: submitted prompt');
    });
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Text: submitted prompt');
    });
    await user.keyboard('first line{Shift>}{Enter}{/Shift}second line');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s+second line/);
    });

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: submitted prompt');
    });

    fireEditorKeyDown(prompt, { key: 'ArrowDown', code: 'ArrowDown' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*first line\s+second line/);
    });
  });

  it('navigates recalled prompts with Ctrl+P and Ctrl+N', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('first prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('second prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');

    fireEditorKeyDown(prompt, { key: 'p', code: 'KeyP', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: second prompt');
    });

    fireEditorKeyDown(prompt, { key: 'p', code: 'KeyP', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: first prompt');
    });

    fireEditorKeyDown(prompt, { key: 'n', code: 'KeyN', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: second prompt');
    });
  });

  it('restores a matching prompt with reverse history search', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('beta database prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');
    fireEditorKeyDown(prompt, { key: 'r', code: 'KeyR', ctrlKey: true });

    expect(screen.getByText(/reverse-i-search:/i)).toBeInTheDocument();

    for (const key of ['d', 'a', 't', 'a']) {
      fireEditorKeyDown(prompt, { key, code: `Key${key.toUpperCase()}` });
    }

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: beta database prompt');
    });
    expect(screen.getByText('data')).toBeInTheDocument();

    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(screen.queryByText(/reverse-i-search:/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: beta database prompt');
  });

  it('cycles reverse history search matches with Ctrl+R and Ctrl+S', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha database prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('beta database prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('gamma database prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');
    fireEditorKeyDown(prompt, { key: 'r', code: 'KeyR', ctrlKey: true });

    for (const key of ['d', 'a', 't', 'a', 'b', 'a', 's', 'e']) {
      fireEditorKeyDown(prompt, { key, code: `Key${key.toUpperCase()}` });
    }

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: gamma database prompt');
    });

    fireEditorKeyDown(prompt, { key: 'r', code: 'KeyR', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: beta database prompt');
    });

    fireEditorKeyDown(prompt, { key: 's', code: 'KeyS', ctrlKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: gamma database prompt');
    });
  });

  it('cancels reverse history search back to the pre-search draft', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('beta database prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');
    fireEditorKeyDown(prompt, { key: 'r', code: 'KeyR', ctrlKey: true });

    for (const key of ['d', 'a', 't', 'a']) {
      fireEditorKeyDown(prompt, { key, code: `Key${key.toUpperCase()}` });
    }

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: beta database prompt');
    });

    fireEditorKeyDown(prompt, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByText(/reverse-i-search:/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: working draft');
  });

  it('keeps the current draft on reverse-search misses and closes with Escape', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('alpha prompt');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });
    await user.keyboard('working draft');
    fireEditorKeyDown(prompt, { key: 'r', code: 'KeyR', ctrlKey: true });

    expect(screen.getByText(/reverse-i-search:/i)).toBeInTheDocument();

    for (const key of ['z', 'z', 'z']) {
      fireEditorKeyDown(prompt, { key, code: `Key${key.toUpperCase()}` });
    }

    expect(screen.getByText('zzz')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: working draft');

    fireEditorKeyDown(prompt, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByText(/reverse-i-search:/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: working draft');
  });

  it('restores the canonical prompt and attachment payloads from history', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('inspect @fro');
    await user.keyboard('{Tab}');
    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /insert rich link/i }));
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await user.click(prompt);
    await user.keyboard('second draft');
    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent('Draft: inspect @frontend [Image #2]');
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(placeholder);
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('openai/composer');
    });
    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();

    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    const latestSubmission = screen.getByRole('article', {
      name: /submission 1/i,
    });
    expect(latestSubmission).toHaveTextContent('item:@frontend');
    expect(latestSubmission).toHaveTextContent(
      `local_image:${LOCAL_IMAGE_PATH}`,
    );
    expect(latestSubmission).toHaveTextContent(
      `remote_image:${REMOTE_IMAGE_URL}`,
    );
    expect(latestSubmission).toHaveTextContent(
      'link:openai/composer:https://github.com/openai/composer',
    );
    expect(latestSubmission).toHaveTextContent(
      `Text: inspect @frontend [Image #2] ${placeholder}`,
    );
    expect(latestSubmission).toHaveTextContent(
      'Expanded: inspect @frontend [Image #2] -- batch 1',
    );
  });

  it('recalls an attachment-only submission from history', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await waitFor(() => {
      expect(screen.queryByText(REMOTE_IMAGE_URL)).not.toBeInTheDocument();
    });

    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: 'p', code: 'KeyP', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
    });
  });

  it('keeps repeated prompts with different attachment payloads distinct in history', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('inspect this');
    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await user.click(prompt);
    await user.keyboard('inspect this');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: 'p', code: 'KeyP', ctrlKey: true });
    expect(screen.queryByText(REMOTE_IMAGE_URL)).not.toBeInTheDocument();

    fireEditorKeyDown(prompt, { key: 'p', code: 'KeyP', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
    });
  });
});

describe('Composer task running behavior', () => {
  it('queues a plain prompt while a task is running', async () => {
    const { user, prompt, submissions } = renderRichInput({
      isTaskRunning: true,
    });

    await user.click(prompt);
    await user.keyboard('continue after current task');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: queued');
    });
    expect(submissions()).toHaveTextContent(
      'Text: continue after current task',
    );
  });

  it('lets the host edit the latest queued draft and restore rich queued drafts on interrupt', async () => {
    const user = userEvent.setup();
    render(<QueuedRichRestoreScenario />);
    const prompt = screen.getByRole<HTMLElement>('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('first queued');
    await waitFor(() => expect(prompt).toHaveTextContent('first queued'));
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(screen.getByLabelText(/rich queued count/i)).toHaveTextContent(
        '1',
      ),
    );

    await user.keyboard('ask @fro');
    await user.keyboard('{Tab}');
    await waitFor(() => expect(prompt).toHaveTextContent('ask @frontend'));
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(screen.getByLabelText(/rich queued count/i)).toHaveTextContent(
        '2',
      ),
    );

    await user.click(
      screen.getByRole('button', { name: /edit latest rich queued/i }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/rich restored text/i)).toHaveTextContent(
        'ask @frontend',
      ),
    );
    expect(screen.getByLabelText(/rich queued count/i)).toHaveTextContent('1');
    expect(screen.getByLabelText(/rich queued drafts/i)).toHaveTextContent(
      'first queued',
    );
    expect(screen.getByLabelText(/rich restored elements/i)).toHaveTextContent(
      'mention:@frontend',
    );

    await user.click(
      screen.getByRole('button', { name: /interrupt rich restore/i }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/rich restored text/i).textContent).toBe(
        'first queued\nask @frontend',
      ),
    );
    expect(screen.getByLabelText(/rich queued count/i)).toHaveTextContent('0');
    expect(screen.getByLabelText(/rich restored elements/i)).toHaveTextContent(
      'mention:@frontend',
    );
  });

  it('restores hidden paste payloads when editing a queued draft', async () => {
    const user = userEvent.setup();
    render(<QueuedRichRestoreScenario />);
    const prompt = screen.getByRole<HTMLElement>('textbox', {
      name: /rich prompt composer/i,
    });
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('inspect ');
    await user.click(
      screen.getByRole('button', { name: /insert queued paste/i }),
    );
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText(/rich queued count/i)).toHaveTextContent(
        '1',
      );
    });

    await user.click(
      screen.getByRole('button', { name: /edit latest rich queued/i }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/rich restored text/i)).toHaveTextContent(
        placeholder,
      );
    });

    const restoredPrompt = screen.getByRole<HTMLElement>('textbox', {
      name: /rich prompt composer/i,
    });
    fireEditorKeyDown(restoredPrompt, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(screen.getByLabelText(/rich submitted prompt/i)).toHaveTextContent(
        '-- batch 1',
      );
    });
  });

  it('keeps a plain prompt editable when Tab is pressed while a task is running', async () => {
    const { user, prompt, submissions } = renderRichInput({
      isTaskRunning: true,
    });

    await user.click(prompt);
    await user.keyboard('do not queue with tab');
    await user.keyboard('{Tab}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: do not queue with tab');
  });

  it('queues a leading slash command with args as ParseSlash while a task is running', async () => {
    const { user, prompt, submissions } = renderRichInput({
      isTaskRunning: true,
    });

    await user.click(prompt);
    await user.keyboard('/review inspect this patch');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: queued');
    });
    expect(submissions()).toHaveTextContent('Action: ParseSlash');
    expect(submissions()).toHaveTextContent('Command: review');
    expect(submissions()).toHaveTextContent('Args: inspect this patch');
  });

  it('queues an unknown leading slash prompt as ParseSlash while a task is running', async () => {
    const { user, prompt, submissions } = renderRichInput({
      isTaskRunning: true,
    });

    await user.click(prompt);
    await user.keyboard('/unknown inspect this patch');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Mode: queued');
    });
    expect(submissions()).toHaveTextContent('Action: ParseSlash');
    expect(submissions()).toHaveTextContent('Command: none');
    expect(submissions()).toHaveTextContent(
      'Text: /unknown inspect this patch',
    );
    expect(
      screen.queryByText(/unrecognized command: \/unknown/i),
    ).not.toBeInTheDocument();
  });
});

describe('Composer disabled guard', () => {
  it('blocks typing, paste, toolbar actions, and keyboard submit while disabled', async () => {
    const { user, prompt, submissions } = renderRichInput({ disabled: true });

    expect(prompt).toHaveAttribute('aria-disabled', 'true');
    expect(prompt).toHaveAttribute('contenteditable', 'false');

    await user.click(prompt);
    await user.keyboard('blocked text');
    await user.keyboard('{Enter}');
    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );
    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /insert rich link/i }));
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
    expect(prompt).toHaveTextContent('');
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Prepared: empty');
    expect(
      screen.getByRole('button', { name: /attach local image/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /add remote image/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /insert large paste/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /insert rich link/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /submit prompt/i }),
    ).toBeDisabled();
  });

  it('blocks remote-image-only keyboard and button submit while disabled', async () => {
    const { user, prompt, submissions } = renderRichInput({
      disabled: true,
      initialRemoteImageUrls: [REMOTE_IMAGE_URL],
    });

    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
    await user.click(prompt);
    await user.keyboard('{Enter}');
    await user.keyboard('{Tab}');
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(prompt).toHaveAttribute('aria-disabled', 'true');
    expect(submissions()).toHaveTextContent('No submissions');
    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
  });
});

describe('Composer prompt length cap', () => {
  it('rejects oversized plain text without clearing the draft', async () => {
    const { user, prompt, submissions } = renderRichInput({
      maxExpandedTextChars: 12,
    });

    await user.click(prompt);
    await user.keyboard('this draft is too long');
    fireEditorKeyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByText(/prompt is too long after expanding pasted content/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent('Draft: this draft is too long');
  });

  it('rejects oversized expanded paste content while preserving the atom', async () => {
    const { user, submissions } = renderRichInput({
      maxExpandedTextChars: 100,
    });
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByText(/prompt is too long after expanding pasted content/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent(`Draft: ${placeholder}`);
  });

  it('rejects oversized slash command args after expanding paste content', async () => {
    const { user, prompt, submissions } = renderRichInput({
      maxExpandedTextChars: 100,
    });
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    await user.keyboard('/review ');
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
    expect(
      screen.getByText(/prompt is too long after expanding pasted content/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent(`Draft: /review ${placeholder}`);
  });
});

describe('Composer persisted-text restore', () => {
  const SPACED_CANDIDATE: ComposerItemEntry = {
    id: 'skill-revenue',
    trigger: '$',
    value: 'Revenue Analysis',
    label: 'Revenue Analysis',
    detail: 'skill',
    atomic: true,
    persistsAs: '[$Revenue Analysis](skill://revenue)',
    payload: { path: 'skill://revenue', type: 'skill' },
  };

  it('rebinds an item whose value contains spaces', () => {
    const draft = createDraftFromPersistedText({
      text: 'use $Revenue Analysis now',
      slashCommands: [],
      commandTriggers: [],
      mentionCandidates: [SPACED_CANDIDATE],
    });

    expect(draft.mentionBindings).toEqual([
      expect.objectContaining({ trigger: '$', value: 'Revenue Analysis' }),
    ]);
  });

  it('does not rebind a token that only prefixes an item value', () => {
    const draft = createDraftFromPersistedText({
      text: 'use $Revenues now',
      slashCommands: [],
      commandTriggers: [],
      mentionCandidates: [
        { ...SPACED_CANDIDATE, value: 'Revenue', label: 'Revenue' },
      ],
    });

    expect(draft.mentionBindings).toEqual([]);
  });

  it('rebinds items under a trigger the host invented', () => {
    const draft = createDraftFromPersistedText({
      text: 'run ::audit today',
      slashCommands: [],
      commandTriggers: [],
      mentionCandidates: [
        { ...SPACED_CANDIDATE, trigger: '::', value: 'audit', label: 'audit' },
      ],
    });

    expect(draft.mentionBindings).toEqual([
      expect.objectContaining({ trigger: '::', value: 'audit' }),
    ]);
  });
});

describe('Composer link and paste behavior', () => {
  it('restores Markdown-style text links and skill links as structured state', async () => {
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt(
        'read [docs](composer-text-link://https%3A%2F%2Fexample.test%2Fdocs) with $react-test',
      ),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(
      'link:docs:https://example.test/docs',
    );
    expect(submissions()).toHaveTextContent('item:$react-test');
  });

  it('persists a mention as the host-supplied persistsAs text', async () => {
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt('use $react-test now'),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(
      'Text: use [$react-test](skill://react-test) now',
    );
  });

  it('persists a mention without persistsAs as its plain token', async () => {
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt('ask @frontend now'),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: ask @frontend now');
  });

  it('keeps prompt links inside code as literal text', async () => {
    const persistedPrompt = 'use `$react-test` literally';
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt(persistedPrompt),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(`Text: ${persistedPrompt}`);
    expect(submissions()).not.toHaveTextContent('item:$react-test');
  });

  it('keeps a Markdown link inside code as literal text', async () => {
    const persistedPrompt = 'use `[$react-test](skill://react-test)` literally';
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt(persistedPrompt),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(`Text: ${persistedPrompt}`);
    expect(submissions()).not.toHaveTextContent('item:$react-test');
  });

  it('decodes a persisted skill link back into an item', async () => {
    const { user, submissions } = renderRichInput({
      initialState: stateFromPersistedPrompt(
        'use [$react-test](skill://react-test) now',
      ),
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('item:$react-test');
    expect(submissions()).toHaveTextContent(
      'Text: use [$react-test](skill://react-test) now',
    );
  });

  it('refreshes restored mention bindings from the current mention catalog', async () => {
    const text = 'inspect @frontend';
    const label = '@frontend';
    const start = text.indexOf(label);
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: [],
    });
    const { user, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [
          {
            id: 'stale-frontend',
            kind: 'mention',
            label,
            range: { start, end: start + label.length },
            detail: 'plugin://old-frontend',
          },
        ],
        mentionBindings: [
          {
            id: 'stale-frontend',
            trigger: '@',
            value: 'frontend',
            payload: { path: 'plugin://old-frontend', type: 'plugin' },
          },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('item:@frontend');
    expect(submissions()).not.toHaveTextContent('plugin://old-frontend');
  });

  it('turns selected text into the label when a URL is pasted over it', async () => {
    const { prompt, submissions } = renderRichInput({
      initialText: 'open docs',
    });
    selectText(prompt, 'docs');

    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/docs'),
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
        'href',
        'https://example.test/docs',
      );
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(
      'link:docs:https://example.test/docs',
    );
    expect(submissions()).toHaveTextContent(
      'Text: open [docs](https://example.test/docs)',
    );
  });

  it('pasting a URL over a selection spanning text and an image atom links the text and prunes the image payload', async () => {
    const linkLabel = 'docs';
    const imageLabel = '[Image #1]';
    const text = `open ${linkLabel}${imageLabel} tail`;
    const linkStart = text.indexOf(linkLabel);
    const imageStart = text.indexOf(imageLabel);
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: MENTION_CANDIDATES,
    });
    const { prompt, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [
          {
            id: 'image-1',
            kind: 'image',
            label: imageLabel,
            range: { start: imageStart, end: imageStart + imageLabel.length },
            detail: LOCAL_IMAGE_PATH,
          },
        ],
        localImages: [
          {
            id: 'image-1',
            placeholder: imageLabel,
            path: LOCAL_IMAGE_PATH,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${text}`);
    });

    selectTextRange(prompt, linkLabel, imageLabel);
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/docs'),
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
        'href',
        'https://example.test/docs',
      );
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: open docs tail');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(
      'link:docs:https://example.test/docs',
    );
    expect(submissions()).toHaveTextContent(
      'Text: open [docs](https://example.test/docs) tail',
    );
    expect(submissions()).not.toHaveTextContent(
      `local_image:${LOCAL_IMAGE_PATH}`,
    );
    expect(submissions()).not.toHaveTextContent(`image:${imageLabel}`);
  });

  it('turns collapsed URL paste into a structured text link', async () => {
    const { prompt, submissions } = renderRichInput();

    prompt.focus();
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/docs'),
    });

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: 'https://example.test/docs' }),
      ).toHaveAttribute('href', 'https://example.test/docs');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(
      'link:https://example.test/docs:https://example.test/docs',
    );
    expect(submissions()).toHaveTextContent(
      'Text: [https://example.test/docs](https://example.test/docs)',
    );
  });

  it('replaces a linked selection with non-URL pasted text and clears stale link metadata', async () => {
    const { prompt, submissions } = renderRichInput({
      initialText: 'open docs',
    });

    selectText(prompt, 'docs');
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/docs'),
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
        'href',
        'https://example.test/docs',
      );
    });

    selectText(prompt, 'docs');
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('manual'),
    });

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'manual' })).toBeNull();
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: open manual');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('Text: open manual');
    expect(submissions()).not.toHaveTextContent('link:');
  });

  it('keeps duplicate selected-text URL paste links distinct', async () => {
    const { prompt, submissions } = renderRichInput({
      initialText: 'docs and docs',
    });

    selectText(prompt, 'docs');
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/first'),
    });
    selectText(prompt, 'docs', 1);
    fireEvent.paste(prompt, {
      clipboardData: clipboardText('https://example.test/second'),
    });

    await waitFor(() => {
      expect(
        screen
          .getAllByRole('link', { name: 'docs' })
          .map((link) => link.getAttribute('href')),
      ).toEqual(['https://example.test/first', 'https://example.test/second']);
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(
      'link:docs:https://example.test/first',
    );
    expect(submissions()).toHaveTextContent(
      'link:docs:https://example.test/second',
    );
    expect(submissions()).toHaveTextContent(
      'Text: [docs](https://example.test/first) and [docs](https://example.test/second)',
    );
  });

  it('pastes file URI references as structured file mentions', async () => {
    const { prompt, submissions } = renderRichInput();

    fireEvent.paste(prompt, {
      clipboardData: clipboardData({
        'text/uri-list':
          '# copied from file manager\nfile:///Users/ezzabuzaid/project/schema.sql',
      }),
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: @schema.sql');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('item:@schema.sql');
  });

  it('pastes non-image clipboard files as structured file mentions', async () => {
    const { prompt, submissions } = renderRichInput();
    const file = new File(['select 1'], 'query.sql', { type: 'text/sql' });

    fireEvent.paste(prompt, {
      clipboardData: {
        files: [file],
        getData: () => '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: @query.sql');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('item:@query.sql');
  });

  it('pastes image clipboard files as local image atoms', async () => {
    const { prompt, submissions } = renderRichInput();
    const file = new File(['png'], 'clipboard.png', { type: 'image/png' });

    fireEvent.paste(prompt, {
      clipboardData: {
        files: [file],
        getData: () => '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('local_image:clipboard.png');
  });

  it('pastes image paths as local image atoms', async () => {
    const { prompt, submissions } = renderRichInput();
    const path = '/Users/ezzabuzaid/project/chart.png';

    fireEvent.paste(prompt, {
      clipboardData: clipboardText(path),
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(`local_image:${path}`);
  });

  it('drops image files as local image atoms', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const file = new File(['png'], 'dropped.png', { type: 'image/png' });

    await user.click(prompt);
    fireEvent.drop(prompt, {
      dataTransfer: {
        files: [file],
        getData: () => '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('local_image:dropped.png');
  });

  it('drops file URI references as structured file mentions', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    fireEvent.drop(prompt, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === 'text/uri-list'
            ? 'file:///Users/ezzabuzaid/project/report.csv'
            : '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: @report.csv');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('item:@report.csv');
  });

  it('drops image DownloadURL values as local image atoms', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    fireEvent.drop(prompt, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === 'DownloadURL'
            ? 'image/png:chart.png:https://example.test/chart.png'
            : '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(
      'local_image:https://example.test/chart.png',
    );
  });

  it('drops file DownloadURL values as structured file mentions', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    fireEvent.drop(prompt, {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === 'DownloadURL'
            ? 'text/csv:report.csv:file:///Users/ezzabuzaid/project/report.csv'
            : '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: @report.csv');
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent('item:@report.csv');
  });

  it('turns browser pastes over the large-paste threshold into paste atoms', async () => {
    const { prompt, submissions } = renderRichInput();
    const pasted = 'A'.repeat(1001);
    const placeholder = '[Pasted Content 1001 chars]';

    fireEvent.paste(prompt, {
      clipboardData: clipboardText(pasted),
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${placeholder}`);
    });

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(`Text: ${placeholder}`);
    expect(submissions()).toHaveTextContent(`Expanded: ${pasted}`);
  });

  it('shows a paste atom while submitting expanded pasted content', async () => {
    const { user, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );

    expect(
      screen.getByRole('region', { name: /rich composer snapshot/i }),
    ).toHaveTextContent(`Draft: ${placeholder}`);

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(
      `Text: ${placeholder}Expanded: -- batch 1 CREATE TABLE invoices`,
    );
  });

  it('suffixes duplicate-size paste atoms and expands both on submit', async () => {
    const { user, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;
    const duplicatePlaceholder = `${placeholder} #2`;

    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${placeholder}${duplicatePlaceholder}`);
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(
      `Text: ${placeholder}${duplicatePlaceholder}`,
    );
    expect(submissions()).toHaveTextContent(
      'Expanded: -- batch 1 CREATE TABLE invoices',
    );
    expect(submissions()).toHaveTextContent(
      'GROUP BY status;-- batch 1 CREATE TABLE invoices',
    );
  });

  it('submits explicit rich link atoms as rich link items', async () => {
    const { user, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /insert rich link/i }));
    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent(
      'rich_link:openai/composer:https://github.com/openai/composer',
    );
    expect(submissions()).toHaveTextContent('OpenAI Composer');
  });
});

describe('Composer atomic token deletion', () => {
  it('deletes a local image atom and prunes the image item', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });

    selectText(prompt, '[Image #1]');
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).not.toHaveTextContent('[Image #1]');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
  });

  it('backspaces from a local image atom edge and prunes the image item', async () => {
    const { user, prompt, submissions } = renderRichInput({
      initialText: 'keep ',
    });

    await user.click(prompt);
    placeCursorAfterText(prompt, 'keep ');
    await user.click(
      screen.getByRole('button', { name: /attach local image/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep [Image #1]');
    });

    placeCursorAfterText(prompt, '[Image #1]');
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep ');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: keep');
    expect(submissions()).not.toHaveTextContent(
      `local_image:${LOCAL_IMAGE_PATH}`,
    );
  });

  it('deletes a paste atom and prunes expanded pasted content', async () => {
    const { user, prompt, submissions } = renderRichInput();
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${placeholder}`);
    });

    selectText(prompt, placeholder);
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).not.toHaveTextContent(placeholder);
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
  });

  it('deletes a paste atom from its leading edge and prunes expanded pasted content', async () => {
    const { user, prompt, submissions } = renderRichInput({
      initialText: 'keep ',
    });
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    placeCursorAfterText(prompt, 'keep ');
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: keep ${placeholder}`);
    });

    placeCursorAfterText(prompt, 'keep ');
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep ');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: keep');
    expect(submissions()).not.toHaveTextContent('Expanded: -- batch 1');
  });

  it('backspaces from a paste atom trailing edge and prunes expanded pasted content', async () => {
    const { user, prompt, submissions } = renderRichInput({
      initialText: 'keep ',
    });
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;

    await user.click(prompt);
    placeCursorAfterText(prompt, 'keep ');
    await user.click(
      screen.getByRole('button', { name: /insert large paste/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: keep ${placeholder}`);
    });

    placeCursorAfterText(prompt, placeholder);
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep ');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: keep');
    expect(submissions()).not.toHaveTextContent('Expanded: -- batch 1');
  });

  it('deletes a mention atom and prunes the mention binding', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('inspect @fro');
    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: inspect @frontend ');
    });

    selectText(prompt, '@frontend');
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).not.toHaveTextContent('@frontend');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).not.toHaveTextContent('item:@frontend');
    expect(submissions()).toHaveTextContent('Text: inspect');
  });

  it('backspaces from a mention atom edge and prunes the mention binding', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('inspect @fro');
    await user.keyboard('{Tab}');

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: inspect @frontend ');
    });

    placeCursorAfterText(prompt, '@frontend');
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).not.toHaveTextContent('@frontend');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).not.toHaveTextContent('item:@frontend');
    expect(submissions()).toHaveTextContent('Text: inspect');
  });

  it('deletes a rich-link atom and prunes the rich link item', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /insert rich link/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: openai/composer');
    });

    selectText(prompt, 'openai/composer');
    fireEditorKeyDown(prompt, { key: 'Backspace', code: 'Backspace' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).not.toHaveTextContent('openai/composer');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('No submissions');
  });

  it('deletes a selection spanning a text link and local image atom and prunes both structured items', async () => {
    const text = 'open docs[Image #1]tail';
    const linkLabel = 'docs';
    const imageLabel = '[Image #1]';
    const linkStart = text.indexOf(linkLabel);
    const imageStart = text.indexOf(imageLabel);
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: MENTION_CANDIDATES,
    });

    const { user, prompt, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [
          {
            id: 'link-docs',
            kind: 'link',
            label: linkLabel,
            range: { start: linkStart, end: linkStart + linkLabel.length },
            detail: 'https://example.test/docs',
          },
          {
            id: 'image-1',
            kind: 'image',
            label: imageLabel,
            range: { start: imageStart, end: imageStart + imageLabel.length },
            detail: LOCAL_IMAGE_PATH,
          },
        ],
        localImages: [
          {
            id: 'image-1',
            placeholder: imageLabel,
            path: LOCAL_IMAGE_PATH,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${text}`);
    });

    selectTextRange(prompt, linkLabel, imageLabel);
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: open tail');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: open tail');
    expect(submissions()).not.toHaveTextContent(
      'link:docs:https://example.test/docs',
    );
    expect(submissions()).not.toHaveTextContent(
      `local_image:${LOCAL_IMAGE_PATH}`,
    );
    expect(submissions()).not.toHaveTextContent(`image:${imageLabel}`);
    expect(submissions()).not.toHaveTextContent('rich_link:');
  });

  it('deletes a selection spanning image and paste atoms and prunes both payloads', async () => {
    const imageLabel = '[Image #1]';
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;
    const text = `keep ${imageLabel}${placeholder} tail`;
    const imageStart = text.indexOf(imageLabel);
    const pasteStart = text.indexOf(placeholder);
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: MENTION_CANDIDATES,
    });

    const { user, prompt, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [
          {
            id: 'image-1',
            kind: 'image',
            label: imageLabel,
            range: { start: imageStart, end: imageStart + imageLabel.length },
            detail: LOCAL_IMAGE_PATH,
          },
          {
            id: 'paste-1',
            kind: 'paste',
            label: placeholder,
            range: {
              start: pasteStart,
              end: pasteStart + placeholder.length,
            },
            detail: `${Array.from(LARGE_PASTE).length} chars`,
          },
        ],
        localImages: [
          {
            id: 'image-1',
            placeholder: imageLabel,
            path: LOCAL_IMAGE_PATH,
          },
        ],
        pendingPastes: [
          {
            id: 'paste-1',
            placeholder,
            content: LARGE_PASTE,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(`Draft: ${text}`);
    });

    selectTextRange(prompt, imageLabel, placeholder);
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: keep tail');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: keep tail');
    expect(submissions()).not.toHaveTextContent(
      `local_image:${LOCAL_IMAGE_PATH}`,
    );
    expect(submissions()).not.toHaveTextContent('Expanded: -- batch 1');
  });

  it('deletes a cross-line selection spanning mention and paste atoms and prunes both payloads', async () => {
    const mentionLabel = '@frontend';
    const placeholder = `[Pasted Content ${Array.from(LARGE_PASTE).length} chars]`;
    const text = `keep ${mentionLabel}\n${placeholder} tail`;
    const mentionStart = text.indexOf(mentionLabel);
    const pasteStart = text.indexOf(placeholder);
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: MENTION_CANDIDATES,
    });

    const { user, prompt, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [
          {
            id: 'mention-frontend',
            kind: 'mention',
            label: mentionLabel,
            range: {
              start: mentionStart,
              end: mentionStart + mentionLabel.length,
            },
            detail: 'plugin://frontend',
          },
          {
            id: 'paste-1',
            kind: 'paste',
            label: placeholder,
            range: { start: pasteStart, end: pasteStart + placeholder.length },
            detail: `${Array.from(LARGE_PASTE).length} chars`,
          },
        ],
        mentionBindings: [
          {
            id: 'mention-frontend',
            trigger: '@',
            value: 'frontend',
            payload: { path: 'plugin://frontend', type: 'plugin' },
          },
        ],
        pendingPastes: [{ id: 'paste-1', placeholder, content: LARGE_PASTE }],
      },
    });

    await waitFor(() => {
      const snapshot = screen.getByRole('region', {
        name: /rich composer snapshot/i,
      });
      expect(snapshot).toHaveTextContent(`Draft: keep ${mentionLabel}`);
      expect(snapshot).toHaveTextContent(`${placeholder} tail`);
    });

    selectTextRange(prompt, mentionLabel, placeholder);
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent(/Draft:\s*keep\s+tail/);
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    expect(submissions()).toHaveTextContent('Text: keep tail');
    expect(submissions()).not.toHaveTextContent('item:@frontend');
    expect(submissions()).not.toHaveTextContent('Expanded: -- batch 1');
  });

  it('edits a slash token and prunes slash-command metadata', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(prompt);
    await user.keyboard('hello /pla');
    await user.keyboard('{Tab}');
    await user.keyboard('now');
    fireEditorKeyDown(prompt, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: hello /plan now');
    });

    selectText(prompt, '/plan');
    await user.keyboard('/pan');
    fireEditorKeyDown(prompt, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(prompt).toHaveTextContent('hello /pan now');
    });

    await user.click(screen.getByRole('button', { name: /submit prompt/i }));

    await waitFor(() => {
      expect(submissions()).toHaveTextContent('Text: hello /pan now');
    });
  });
});

describe('Composer remote image behavior', () => {
  it('submits a remote-image-only prompt with Enter', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(prompt);
    await user.keyboard('{Enter}');

    expect(submissions()).toHaveTextContent(`remote_image:${REMOTE_IMAGE_URL}`);
  });

  it('keeps a remote-image-only prompt editable when Tab is pressed', async () => {
    const { user, prompt, submissions } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(prompt);
    await user.keyboard('{Tab}');

    expect(submissions()).toHaveTextContent('No submissions');
    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();
  });

  it('selects and removes a remote image from the keyboard', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));

    expect(screen.getByText(REMOTE_IMAGE_URL)).toBeInTheDocument();

    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(screen.queryByText(REMOTE_IMAGE_URL)).not.toBeInTheDocument();
    });
  });

  it('clears a selected remote image when editing or clicking inside the editor', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    fireEditorKeyDown(prompt, { key: 'x', code: 'KeyX' });

    await waitFor(() => {
      expect(remoteImageRow()).not.toHaveClass('bg-primary');
    });

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    await user.click(prompt);

    await waitFor(() => {
      expect(remoteImageRow()).not.toHaveClass('bg-primary');
    });
  });

  it('clears a selected remote image for navigation, escape, and select-all keys', async () => {
    const { user, prompt } = renderRichInput();

    await user.click(screen.getByRole('button', { name: /add remote image/i }));
    await user.click(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    fireEditorKeyDown(prompt, { key: 'ArrowRight', code: 'ArrowRight' });

    await waitFor(() => {
      expect(remoteImageRow()).not.toHaveClass('bg-primary');
    });

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    fireEditorKeyDown(prompt, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(remoteImageRow()).not.toHaveClass('bg-primary');
    });

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });

    expect(remoteImageRow()).toHaveClass('bg-primary');

    fireEditorKeyDown(prompt, { key: 'a', code: 'KeyA', ctrlKey: true });

    await waitFor(() => {
      expect(remoteImageRow()).not.toHaveClass('bg-primary');
    });
  });

  it('renumbers local image atoms after a selected remote image is deleted', async () => {
    const placeholder = '[Image #2]';
    const initialState = createComposerState({
      commandTriggers: COMMAND_TRIGGERS,
      text: placeholder,
      slashCommands: SLASH_COMMANDS,
      mentionCandidates: MENTION_CANDIDATES,
      remoteImageUrls: [REMOTE_IMAGE_URL],
    });
    const imageElement = {
      id: `image:0:${placeholder}`,
      kind: 'image' as const,
      label: placeholder,
      range: { start: 0, end: placeholder.length },
      detail: LOCAL_IMAGE_PATH,
    };
    const { prompt, submissions } = renderRichInput({
      initialState: {
        ...initialState,
        elements: [imageElement],
        localImages: [
          {
            id: imageElement.id,
            placeholder,
            path: LOCAL_IMAGE_PATH,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #2]');
    });

    placeCursorAtStart(prompt);
    fireEditorKeyDown(prompt, { key: 'ArrowUp', code: 'ArrowUp' });
    fireEditorKeyDown(prompt, { key: 'Delete', code: 'Delete' });

    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Draft: [Image #1]');
    });
    expect(screen.queryByText(REMOTE_IMAGE_URL)).not.toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' });

    expect(submissions()).toHaveTextContent(`local_image:${LOCAL_IMAGE_PATH}`);
    expect(submissions()).not.toHaveTextContent(
      `remote_image:${REMOTE_IMAGE_URL}`,
    );
  });
});

function selectText(root: HTMLElement, text: string, occurrence = 0) {
  const match = findTextOccurrence(root, text, occurrence);
  if (!match) {
    throw new Error(`Could not find text node containing ${text}`);
  }
  root.focus();
  const range = document.createRange();
  range.setStart(match.node, match.start);
  range.setEnd(match.node, match.start + text.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectTextRange(
  root: HTMLElement,
  startText: string,
  endText: string,
) {
  const start = findTextOccurrence(root, startText, 0);
  const end = findTextOccurrence(root, endText, 0);
  if (!start) {
    throw new Error(`Could not find selection start ${startText}`);
  }
  if (!end) {
    throw new Error(`Could not find selection end ${endText}`);
  }
  root.focus();
  const range = document.createRange();
  range.setStart(start.node, start.start);
  range.setEnd(end.node, end.start + endText.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCursorAfterText(root: HTMLElement, text: string) {
  const textNode = findTextNode(root, text);
  if (!textNode) {
    throw new Error(`Could not find text node containing ${text}`);
  }
  const start = textNode.textContent?.indexOf(text) ?? -1;
  if (start === -1) {
    throw new Error(`Could not place cursor after missing text ${text}`);
  }
  root.focus();
  const range = document.createRange();
  range.setStart(textNode, start + text.length);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCursorBeforeText(root: HTMLElement, text: string) {
  const textNode = findTextNode(root, text);
  if (!textNode) {
    throw new Error(`Could not find text node containing ${text}`);
  }
  const start = textNode.textContent?.indexOf(text) ?? -1;
  if (start === -1) {
    throw new Error(`Could not place cursor before missing text ${text}`);
  }
  root.focus();
  const range = document.createRange();
  range.setStart(textNode, start);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCursorAtStart(root: HTMLElement) {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function fireEditorKeyDown(
  root: HTMLElement,
  event: Parameters<typeof fireEvent.keyDown>[1],
) {
  act(() => {
    fireEvent.keyDown(root, event);
  });
}

async function fireEditorKeyDownSettled(
  root: HTMLElement,
  event: Parameters<typeof fireEvent.keyDown>[1],
) {
  await act(async () => {
    fireEvent.keyDown(root, event);
  });
}

function remoteImageRow() {
  const row = screen.getByText('[Image #1]').closest('div');
  if (!row) {
    throw new Error('Expected the remote image row to be rendered');
  }
  return row;
}

function findTextNode(root: Node, text: string): Text | null {
  if (root instanceof Text && root.textContent?.includes(text)) {
    return root;
  }
  for (const child of Array.from(root.childNodes)) {
    const found = findTextNode(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}

function findTextOccurrence(
  root: Node,
  text: string,
  occurrence: number,
): { node: Text; start: number } | null {
  if (root instanceof Text) {
    const content = root.textContent ?? '';
    let fromIndex = 0;
    while (fromIndex <= content.length) {
      const start = content.indexOf(text, fromIndex);
      if (start === -1) {
        break;
      }
      if (occurrence === 0) {
        return { node: root, start };
      }
      occurrence -= 1;
      fromIndex = start + text.length;
    }
  }
  for (const child of Array.from(root.childNodes)) {
    const found = findTextOccurrence(child, text, occurrence);
    if (found) {
      return found;
    }
    occurrence -= countTextOccurrences(child, text);
  }
  return null;
}

function countTextOccurrences(root: Node, text: string): number {
  if (root.nodeType === Node.TEXT_NODE) {
    const content = root.textContent ?? '';
    let count = 0;
    let fromIndex = 0;
    while (fromIndex <= content.length) {
      const start = content.indexOf(text, fromIndex);
      if (start === -1) {
        break;
      }
      count += 1;
      fromIndex = start + text.length;
    }
    return count;
  }
  return Array.from(root.childNodes).reduce(
    (count, child) => count + countTextOccurrences(child, text),
    0,
  );
}

function clipboardText(text: string) {
  return clipboardData({
    'text/plain': text,
    text,
  });
}

function clipboardData(data: Record<string, string>) {
  return {
    files: [],
    getData: (type: string) => data[type] ?? '',
  };
}

function StateChangeCountScenario() {
  const [parentRenders, setParentRenders] = useState(0);
  const [stateChanges, setStateChanges] = useState(0);

  return (
    <>
      <Composer.Root
        initialDraft={{ text: 'a draft that produces a prepared payload' }}
        onStateChange={() => setStateChanges((current) => current + 1)}
      >
        {registryTriggers()}
        <Composer.Content>
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>
      <button
        type="button"
        onClick={() => setParentRenders((current) => current + 1)}
      >
        Force parent render
      </button>
      <section aria-label="composer notifications">
        <p>Parent renders: {parentRenders}</p>
        <p>State changes: {stateChanges}</p>
      </section>
    </>
  );
}

describe('Composer registry-dependent restore', () => {
  it('rebuilds the slash-command mark and command payload for a known command', async () => {
    const { prompt } = renderRichInput({
      initialText: '/review Please inspect this patch',
    });

    const mark = prompt.querySelector('[data-token="slash-command"]');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('/review');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Prepared: command-with-args:');
    });
  });

  it('rebuilds mention atoms with their bindings when restoring a draft', async () => {
    const { prompt } = renderRichInput({
      initialText: 'Ask @frontend and $react-test about this',
    });

    const plugin = prompt.querySelector('[data-composer-mention="frontend"]');
    expect(plugin).not.toBeNull();
    expect(plugin).toHaveTextContent('@frontend');
    expect(plugin).toHaveAttribute('data-composer-mention-trigger', '@');

    const skill = prompt.querySelector('[data-composer-mention-trigger="$"]');
    expect(skill).not.toBeNull();
    expect(skill).toHaveTextContent('$react-test');
  });

  it('leaves an unknown slash command as plain text with no command payload', async () => {
    const { prompt } = renderRichInput({
      initialText: '/unregistered do the thing',
    });

    expect(prompt.querySelector('[data-token="slash-command"]')).toBeNull();
    expect(prompt).toHaveTextContent('/unregistered do the thing');
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /rich composer snapshot/i }),
      ).toHaveTextContent('Prepared: submitted:');
    });
  });

  it('notifies state changes only for real state changes, not parent re-renders', async () => {
    const user = userEvent.setup();
    render(<StateChangeCountScenario />);
    const notifications = () =>
      screen.getByRole('region', { name: /composer notifications/i });
    const changeCount = () =>
      Number(
        notifications().textContent?.match(/State changes: (\d+)/)?.[1] ?? '0',
      );

    await waitFor(() => {
      expect(changeCount()).toBeGreaterThan(0);
    });
    const mounted = changeCount();

    await user.click(
      screen.getByRole('button', { name: /force parent render/i }),
    );

    expect(notifications()).toHaveTextContent('Parent renders: 1');
    expect(changeCount()).toBe(mounted);

    await user.click(
      screen.getByRole('textbox', { name: /rich prompt composer/i }),
    );
    await user.keyboard('hello');

    await waitFor(() => {
      expect(changeCount()).toBeGreaterThan(mounted);
    });
  });
});

describe('Composer host-declared triggers', () => {
  it('drives suggestions from a non-default command trigger', async () => {
    const user = userEvent.setup();
    const submitted: ComposerSubmission[] = [];
    render(
      <Composer.Root onSubmit={(submission) => submitted.push(submission)}>
        <Composer.Trigger trigger="#">
          <Composer.Command
            id="cmd-deploy"
            value="deploy"
            label="Deploy"
            detail="Ship the build"
          />
        </Composer.Trigger>
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('#dep');

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('#deploy')).toBeInTheDocument();

    await user.keyboard('{Tab}');
    expect(prompt).toHaveTextContent('#deploy');
  });

  it('ignores the former default trigger when the host does not declare it', async () => {
    const user = userEvent.setup();
    render(
      <Composer.Root>
        <Composer.Trigger trigger="#">
          <Composer.Command
            id="cmd-deploy"
            value="deploy"
            label="Deploy"
            detail="Ship the build"
          />
        </Composer.Trigger>
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('/dep');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(prompt).toHaveTextContent('/dep');
  });

  it('lists only the items belonging to the active trigger', async () => {
    const user = userEvent.setup();
    render(
      <Composer.Root>
        {registryTriggers()}
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('/');
    const commandList = await screen.findByRole('listbox');
    expect(within(commandList).getByText('/review')).toBeInTheDocument();
    expect(
      within(commandList).queryByText('@frontend'),
    ).not.toBeInTheDocument();
    expect(
      within(commandList).queryByText('$react-test'),
    ).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.keyboard(' @');
    const mentionList = await screen.findByRole('listbox');
    expect(within(mentionList).getByText('@frontend')).toBeInTheDocument();
    expect(within(mentionList).queryByText('/review')).not.toBeInTheDocument();
    expect(
      within(mentionList).queryByText('$react-test'),
    ).not.toBeInTheDocument();
  });

  it('takes a mention sigil from its enclosing trigger', async () => {
    const user = userEvent.setup();
    render(
      <Composer.Root>
        <Composer.Trigger trigger="~">
          <Composer.Mention
            value="audit"
            payload={{ path: 'skill://audit', type: 'skill' }}
            id="skill-audit"
            label="audit"
            detail="skill"
          />
        </Composer.Trigger>
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('~aud');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('~audit')).toBeInTheDocument();

    await user.keyboard('{Tab}');
    expect(prompt).toHaveTextContent('~audit');
  });

  it('matches mentions under a multi-character trigger', async () => {
    const user = userEvent.setup();
    render(
      <Composer.Root>
        <Composer.Trigger trigger="::">
          <Composer.Mention
            value="audit"
            payload={{ path: 'skill://audit', type: 'skill' }}
            id="skill-audit"
            label="audit"
            detail="skill"
          />
        </Composer.Trigger>
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('::aud');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('::audit')).toBeInTheDocument();

    await user.keyboard('{Tab}');
    expect(prompt).toHaveTextContent('::audit');
  });

  it('leaves the command menu inert when no command trigger is declared', async () => {
    const user = userEvent.setup();
    function MenuScenario() {
      return (
        <Composer.Root>
          <Composer.Trigger trigger="@">
            <Composer.Mention
              value="frontend"
              payload={{ path: 'plugin://frontend', type: 'plugin' }}
              id="plugin-frontend"
              label="frontend"
              detail="plugin"
            />
          </Composer.Trigger>
          <Composer.Content>
            <Composer.Popup />
            <Composer.Editor />
          </Composer.Content>
          <MenuToggle />
        </Composer.Root>
      );
    }
    function MenuToggle() {
      const { actions } = useComposer('MenuToggle');
      return (
        <button type="button" onClick={() => actions.toggleSlashMenu()}>
          Toggle menu
        </button>
      );
    }
    render(<MenuScenario />);

    await user.click(screen.getByRole('button', { name: /toggle menu/i }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('rejects items placed outside a trigger', () => {
    expect(() =>
      render(
        <Composer.Root>
          <Composer.Command
            id="cmd-deploy"
            value="deploy"
            label="Deploy"
            detail="Ship the build"
          />
          <Composer.Content>
            <Composer.Editor />
          </Composer.Content>
        </Composer.Root>,
      ),
    ).toThrow(/must be placed inside a <Composer.Trigger>/);
  });

  it('rejects items hidden behind a wrapper component', () => {
    function SkillItem() {
      return (
        <Composer.Mention
          id="skill-audit"
          value="audit"
          label="audit"
          detail="skill"
        />
      );
    }

    expect(() =>
      render(
        <Composer.Root>
          <Composer.Trigger trigger="$">
            <SkillItem />
          </Composer.Trigger>
          <Composer.Content>
            <Composer.Editor />
          </Composer.Content>
        </Composer.Root>,
      ),
    ).toThrow(/accepts only <Composer.Command> and <Composer.Mention>/);
  });

  it('rejects a trigger that mixes commands and mentions', () => {
    expect(() =>
      render(
        <Composer.Root>
          <Composer.Trigger trigger="/">
            <Composer.Command
              id="cmd-deploy"
              value="deploy"
              label="Deploy"
              detail="Ship the build"
            />
            <Composer.Mention
              value="frontend"
              payload={{ path: 'plugin://frontend', type: 'plugin' }}
              id="plugin-frontend"
              label="frontend"
              detail="plugin"
            />
          </Composer.Trigger>
          <Composer.Content>
            <Composer.Editor />
          </Composer.Content>
        </Composer.Root>,
      ),
    ).toThrow(/already holds commands/);
  });
});

describe('Composer token detection', () => {
  it('does not offer suggestions for a token that repeats its own trigger', async () => {
    const user = userEvent.setup();
    render(
      <Composer.Root>
        {registryTriggers()}
        <Composer.Content>
          <Composer.Popup />
          <Composer.Editor />
        </Composer.Content>
      </Composer.Root>,
    );
    const prompt = screen.getByRole('textbox', {
      name: /rich prompt composer/i,
    });

    await user.click(prompt);
    await user.keyboard('@front@end');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
