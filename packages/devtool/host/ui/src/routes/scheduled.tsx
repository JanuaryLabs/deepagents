import cronstrue from 'cronstrue';
import {
  ArchiveIcon,
  BanIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  ExternalLinkIcon,
  FileClockIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import {
  type LoaderFunctionArgs,
  NavLink,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Textarea,
  cn,
} from '@deepagents/react-shadcn';

import { loadRuntime } from '../app/runtime-data.ts';
import {
  type ScheduleCommand,
  type ScheduleDefinitionInput,
  type ScheduleMutation,
  type ScheduledRunView,
  type ScheduledTaskView,
  usePendingReview,
  useScheduleCommand,
  useScheduledRun,
  useScheduledTasks,
  useTaskRuns,
} from '../app/schedules-data.ts';

const FILTERS = ['all', 'active', 'paused', 'completed', 'archived'] as const;
type Filter = (typeof FILTERS)[number];

export async function loader({ request }: LoaderFunctionArgs) {
  const runtime = await loadRuntime(request.signal);
  return { ...runtime, conversation: runtime.history[0] };
}

export function ScheduledRoute() {
  const href = useLoaderData<typeof loader>().discovery?.capabilities.schedules
    ?.href;
  if (!href) return null;
  return <ScheduledWorkspace href={href} />;
}

function ScheduledWorkspace({ href }: { href: string }) {
  const { runId, taskId } = useParams();
  const reviewing = useLocation().pathname.startsWith('/scheduled/review');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const tasks = useScheduledTasks(href);
  const inbox = usePendingReview(href);
  const command = useScheduleCommand(href);

  const allTasks = tasks.data ?? [];
  const pending = inbox.data ?? [];
  const listedTasks = allTasks
    .filter((task) => filter === 'all' || task.status === filter)
    .filter((task) => matches(task.name, query));
  const listedRuns = pending.filter((run) =>
    matches(taskName(allTasks, run.taskId), query),
  );
  const failed = tasks.isError || inbox.isError;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-r">
        <div className="flex flex-wrap items-center gap-1 px-4 pt-3 pb-2">
          <FilterTab
            active={reviewing}
            render={<NavLink to="/scheduled/review" />}
          >
            Needs review
            {pending.length > 0 ? (
              <Badge className="ml-1.5" variant="secondary">
                {pending.length}
              </Badge>
            ) : null}
          </FilterTab>
          <span className="bg-border mx-1 h-4 w-px" />
          {FILTERS.map((key) => (
            <FilterTab
              key={key}
              active={!reviewing && filter === key}
              render={<NavLink to="/scheduled/tasks" />}
              onClick={() => setFilter(key)}
            >
              {titleCase(key)}
            </FilterTab>
          ))}
          <Button
            className="ml-auto shrink-0"
            size="sm"
            onClick={() => setCreating(true)}
          >
            Create <ChevronDownIcon />
          </Button>
        </div>
        <div className="px-4 pb-2">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              className="rounded-full pl-9"
              placeholder={reviewing ? 'Search runs' : 'Search scheduled tasks'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-6">
          {failed ? (
            <p className="text-muted-foreground px-2 py-6 text-sm">
              Scheduled tasks unavailable.
            </p>
          ) : (reviewing ? inbox : tasks).isPending ? (
            <ListLoading />
          ) : reviewing ? (
            listedRuns.length === 0 ? (
              <EmptyInbox />
            ) : (
              listedRuns.map((run) => (
                <ListRow
                  key={run.id}
                  to={`/scheduled/review/${run.id}`}
                  selected={runId === run.id}
                  icon={<RunDot status={run.status} />}
                  title={taskName(allTasks, run.taskId)}
                  subtitle={`${titleCase(run.status)} · ${relative(
                    run.finishedAt ?? run.occurrenceAt,
                  )}`}
                />
              ))
            )
          ) : listedTasks.length === 0 ? (
            <EmptyTasks onCreate={() => setCreating(true)} />
          ) : (
            listedTasks.map((task) => (
              <ListRow
                key={task.id}
                to={`/scheduled/tasks/${task.id}`}
                selected={taskId === task.id}
                icon={<TaskDot status={task.status} />}
                title={task.name}
                subtitle={taskSubtitle(task)}
              />
            ))
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-col">
        {command.isError ? (
          <div className="px-6 pt-4">
            <Alert variant="destructive">
              <AlertTitle>Action failed</AlertTitle>
              <AlertDescription>{command.error.message}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        {runId ? (
          <RunDetail href={href} runId={runId} command={command} />
        ) : taskId ? (
          <TaskDetail
            href={href}
            taskId={taskId}
            tasks={allTasks}
            command={command}
          />
        ) : (
          <p className="text-muted-foreground p-8 text-sm">
            {reviewing ? 'Select a run.' : 'Select a scheduled task.'}
          </p>
        )}
      </section>

      <CreateTaskDialog
        open={creating}
        command={command}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

function TaskDetail({
  href,
  taskId,
  tasks,
  command,
}: {
  href: string;
  taskId: string;
  tasks: ScheduledTaskView[];
  command: ScheduleMutation;
}) {
  const navigate = useNavigate();
  const { history } = useLoaderData<typeof loader>();
  const runs = useTaskRuns(href, taskId);
  const task = tasks.find(({ id }) => id === taskId);
  if (!task) {
    return (
      <p className="text-muted-foreground p-8 text-sm">
        This scheduled task is no longer available.
      </p>
    );
  }
  const cron = isCron(task.recurrence);
  const archived = task.status === 'archived';
  const update = (definition: Partial<ScheduleDefinitionInput>) =>
    command.mutate({ kind: 'update', taskId, definition });

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-6">
        <div className="flex items-center gap-1">
          <StatusWord status={task.status} />
          <TaskActions
            task={task}
            command={command}
            onPurged={() => navigate('/scheduled/tasks')}
          />
          <Button
            className="size-8 rounded-full"
            size="icon"
            variant="ghost"
            aria-label={task.status === 'paused' ? 'Resume task' : 'Pause task'}
            disabled={archived || task.status === 'completed'}
            onClick={() =>
              command.mutate({
                kind: task.status === 'paused' ? 'resume' : 'pause',
                taskId,
              })
            }
          >
            {task.status === 'paused' ? <PlayIcon /> : <PauseIcon />}
          </Button>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="Close"
            onClick={() => navigate('/scheduled/tasks')}
          >
            <XIcon />
          </Button>
        </div>
        <h2 className="mt-1 mb-5 text-2xl">{task.name}</h2>

        <CommittingTextarea
          aria-label="Prompt"
          disabled={archived}
          value={task.prompt}
          onCommit={(prompt) => update({ prompt })}
        />

        <GroupLabel>Details</GroupLabel>
        <Group>
          <Row label="Name">
            <CommittingInput
              aria-label="Name"
              disabled={archived}
              value={task.name}
              onCommit={(name) => update({ name })}
            />
          </Row>
          <Row label="Runs in">
            <RowSelect
              aria-label="Runs in"
              disabled={archived}
              value={task.target.kind}
              onChange={(event) => {
                const [conversation] = history;
                update({
                  target:
                    event.target.value === 'new-conversation' || !conversation
                      ? { kind: 'new-conversation' }
                      : {
                          kind: 'existing-conversation',
                          chatId: conversation.chatId,
                        },
                });
              }}
            >
              <NativeSelectOption value="new-conversation">
                New chat
              </NativeSelectOption>
              <NativeSelectOption
                value="existing-conversation"
                disabled={history.length === 0}
              >
                Existing chat
              </NativeSelectOption>
            </RowSelect>
          </Row>
          {task.target.kind === 'existing-conversation' ? (
            <Row label="Chat">
              <RowSelect
                aria-label="Chat"
                disabled={archived}
                value={task.target.chatId}
                onChange={(event) =>
                  update({
                    target: {
                      kind: 'existing-conversation',
                      chatId: event.target.value,
                    },
                  })
                }
              >
                {history.map((entry) => (
                  <NativeSelectOption key={entry.chatId} value={entry.chatId}>
                    {entry.title ?? entry.chatId}
                  </NativeSelectOption>
                ))}
              </RowSelect>
            </Row>
          ) : null}
        </Group>

        <GroupLabel>Frequency</GroupLabel>
        <Group>
          <Row label="Repeat">
            {cron ? (
              <CommittingInput
                aria-label="Cron expression"
                className="w-52 text-right font-mono"
                disabled={archived}
                value={task.recurrence}
                onCommit={(recurrence) => update({ recurrence })}
              />
            ) : (
              <span className="text-muted-foreground font-mono text-xs">
                {task.recurrence.split('\n').at(-1)}
              </span>
            )}
          </Row>
          <Row label="Reads as">
            <span className="text-muted-foreground text-sm">
              {describe(task.recurrence)}
            </span>
          </Row>
          <Row label="Timezone">
            <CommittingInput
              aria-label="Timezone"
              className="w-52 text-right"
              disabled={archived}
              value={task.timezone}
              onCommit={(timezone) => update({ timezone })}
            />
          </Row>
          <Row label="Next run">
            <span className="text-muted-foreground text-sm">
              {task.nextRunAt ? relative(task.nextRunAt) : '—'}
            </span>
          </Row>
        </Group>

        <div className="mt-8 mb-2 flex items-center">
          <GroupLabel className="mt-0 mb-0">Previous runs</GroupLabel>
          <span className="text-muted-foreground ml-auto text-xs">
            {runs.data?.length ?? 0}
          </span>
        </div>
        {runs.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : runs.data?.length ? (
          <ul>
            {runs.data.map((run) => (
              <li key={run.id}>
                <NavLink
                  to={`/scheduled/tasks/${taskId}/runs/${run.id}`}
                  className="hover:bg-accent flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left"
                >
                  <FileClockIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="flex-1 truncate text-sm">{task.name}</span>
                  <RunDot status={run.status} />
                  {run.reviewStatus === 'pending_review' ? (
                    <span
                      className="size-1.5 rounded-full bg-sky-500"
                      title="Pending review"
                    />
                  ) : null}
                  <span className="text-muted-foreground w-16 text-right text-xs">
                    {compact(run.finishedAt ?? run.occurrenceAt)}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No runs yet.</p>
        )}
      </div>
      <div className="flex justify-end border-t px-6 py-3">
        <Button
          variant="outline"
          disabled={task.target.kind !== 'existing-conversation'}
          onClick={() =>
            task.target.kind === 'existing-conversation' &&
            navigate(`/chat/${encodeURIComponent(task.target.chatId)}`)
          }
        >
          Open chat <ExternalLinkIcon />
        </Button>
      </div>
    </>
  );
}

function RunDetail({
  href,
  runId,
  command,
}: {
  href: string;
  runId: string;
  command: ScheduleMutation;
}) {
  const navigate = useNavigate();
  const { taskId } = useParams();
  const tasks = useScheduledTasks(href);
  const run = useScheduledRun(href, runId);
  const back = taskId ? `/scheduled/tasks/${taskId}` : '/scheduled/review';

  if (run.isPending) return <WorkspaceLoading />;
  if (run.isError || !run.data) {
    return (
      <p className="text-muted-foreground p-8 text-sm">
        This run is no longer available.
      </p>
    );
  }

  const entry = run.data;
  const terminal = isTerminal(entry.status);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-6">
        <div className="flex items-center gap-1">
          <StatusWord status={entry.status} />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="ml-auto size-8"
                  size="icon"
                  variant="ghost"
                  aria-label="Run actions"
                >
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={terminal}
                onClick={() => command.mutate({ kind: 'cancel', runId })}
              >
                <BanIcon /> Cancel run
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={entry.reviewStatus !== 'pending_review'}
                onClick={() => command.mutate({ kind: 'review', runId })}
              >
                <CheckIcon /> Mark reviewed
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            className="size-8"
            size="icon"
            variant="ghost"
            aria-label="Close"
            onClick={() => navigate(back)}
          >
            <XIcon />
          </Button>
        </div>
        <h2 className="mt-1 mb-5 text-2xl">
          {taskName(tasks.data ?? [], entry.taskId)}
        </h2>

        <div className="bg-muted/40 text-muted-foreground rounded-xl px-4 py-3 text-base">
          {entry.prompt}
        </div>

        <GroupLabel>Details</GroupLabel>
        <Group>
          <Row label="Trigger">{entry.trigger}</Row>
          <Row label="Occurrence">{absolute(entry.occurrenceAt)}</Row>
          <Row label="Started">
            {entry.startedAt ? absolute(entry.startedAt) : '—'}
          </Row>
          <Row label="Finished">
            {entry.finishedAt ? absolute(entry.finishedAt) : '—'}
          </Row>
          <Row label="Review">{reviewLabel(entry.reviewStatus)}</Row>
        </Group>

        <GroupLabel>Conversation</GroupLabel>
        <Group>
          <Row label="Runs in">
            {entry.target.kind === 'new-conversation'
              ? 'New chat'
              : 'Existing chat'}
          </Row>
          <Row label="Chat">
            <span className="font-mono text-xs">
              {entry.conversation ? short(entry.conversation.chatId) : '—'}
            </span>
          </Row>
          <Row label="Turn">
            <span className="font-mono text-xs">
              {entry.conversation ? short(entry.conversation.turnId) : '—'}
            </span>
          </Row>
        </Group>

        {entry.error ? (
          <Alert className="mt-6" variant="destructive">
            <AlertTitle>Run failed</AlertTitle>
            <AlertDescription>{entry.error}</AlertDescription>
          </Alert>
        ) : null}
        {entry.conversation ? null : (
          <p className="text-muted-foreground mt-6 text-sm">
            Cancelled before dispatch, so no conversation exists.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-3">
        {entry.reviewStatus === 'pending_review' ? (
          <Button
            variant="ghost"
            onClick={() => command.mutate({ kind: 'review', runId })}
          >
            <CheckIcon /> Mark reviewed
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={!entry.conversation}
          onClick={() =>
            entry.conversation &&
            navigate(`/chat/${encodeURIComponent(entry.conversation.chatId)}`)
          }
        >
          Open chat <ExternalLinkIcon />
        </Button>
      </div>
    </>
  );
}

function TaskActions({
  task,
  command,
  onPurged,
}: {
  task: ScheduledTaskView;
  command: ScheduleMutation;
  onPurged: () => void;
}) {
  const archived = task.status === 'archived';
  const run = (kind: ScheduleCommand['kind']) =>
    command.mutate({ kind, taskId: task.id } as ScheduleCommand);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="ml-auto size-8"
            size="icon"
            variant="ghost"
            aria-label="Task actions"
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={archived} onClick={() => run('run')}>
          <PlayIcon /> Run now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={archived} onClick={() => run('archive')}>
          <ArchiveIcon /> Archive
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!archived}
          onClick={() =>
            command.mutate(
              { kind: 'purge', taskId: task.id },
              { onSuccess: onPurged },
            )
          }
        >
          <Trash2Icon className="text-destructive" />
          <span className="text-destructive">Delete</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreateTaskDialog({
  open,
  command,
  onClose,
}: {
  open: boolean;
  command: ScheduleMutation;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { history } = useLoaderData<typeof loader>();
  const [draft, setDraft] = useState(blankDefinition);
  const patch = (values: Partial<ScheduleDefinitionInput>) =>
    setDraft((current) => ({ ...current, ...values }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setDraft(blankDefinition());
        onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New scheduled task</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="schedule-name">Name</FieldLabel>
            <Input
              id="schedule-name"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-prompt">Prompt</FieldLabel>
            <Textarea
              id="schedule-prompt"
              rows={3}
              value={draft.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="schedule-cron">Repeat</FieldLabel>
              <Input
                id="schedule-cron"
                className="font-mono"
                value={draft.recurrence}
                onChange={(event) => patch({ recurrence: event.target.value })}
              />
              <FieldDescription>{describe(draft.recurrence)}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="schedule-timezone">Timezone</FieldLabel>
              <Input
                id="schedule-timezone"
                value={draft.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
              <FieldDescription>IANA identifier.</FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="schedule-target">Runs in</FieldLabel>
            <NativeSelect
              id="schedule-target"
              value={
                draft.target.kind === 'new-conversation'
                  ? 'new-conversation'
                  : draft.target.chatId
              }
              onChange={(event) =>
                patch({
                  target:
                    event.target.value === 'new-conversation'
                      ? { kind: 'new-conversation' }
                      : {
                          kind: 'existing-conversation',
                          chatId: event.target.value,
                        },
                })
              }
            >
              <NativeSelectOption value="new-conversation">
                New chat for every run
              </NativeSelectOption>
              {history.map((entry) => (
                <NativeSelectOption key={entry.chatId} value={entry.chatId}>
                  {entry.title ?? entry.chatId}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!draft.name.trim() || !draft.prompt.trim()}
            onClick={() =>
              command.mutate(
                { kind: 'create', definition: draft },
                {
                  onSuccess: (task) => {
                    setDraft(blankDefinition());
                    onClose();
                    if (task && 'status' in task) {
                      navigate(`/scheduled/tasks/${task.id}`);
                    }
                  },
                },
              )
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommittingInput({
  value,
  onCommit,
  className,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  return (
    <Input
      {...props}
      className={cn('h-8 border-0 bg-transparent shadow-none', className)}
      value={editing ? draft : value}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() && draft !== value) onCommit(draft.trim());
      }}
    />
  );
}

function CommittingTextarea({
  value,
  onCommit,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
} & Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  return (
    <Textarea
      {...props}
      className="bg-muted/40 min-h-24 rounded-xl border-0 text-base"
      value={editing ? draft : value}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() && draft !== value) onCommit(draft.trim());
      }}
    />
  );
}

function ListRow({
  to,
  selected,
  icon,
  title,
  subtitle,
}: {
  to: string;
  selected: boolean;
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <NavLink
      to={to}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'hover:bg-accent/60 flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left',
        selected && 'bg-accent hover:bg-accent',
      )}
    >
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {subtitle}
        </span>
      </span>
    </NavLink>
  );
}

function FilterTab({
  active,
  render,
  onClick,
  children,
}: {
  active: boolean;
  render: ReactElement;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      render={render}
      size="sm"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'text-muted-foreground hover:text-foreground shrink-0 rounded-full px-2.5 font-normal',
        active && 'text-foreground font-medium',
      )}
    >
      {children}
    </Button>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/40 divide-border/60 divide-y rounded-xl">
      {children}
    </div>
  );
}

function GroupLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={cn('text-muted-foreground mt-6 mb-2 text-sm', className)}>
      {children}
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-1">
      <span className="shrink-0 text-sm">{label}</span>
      <span className="flex min-w-0 items-center justify-end text-sm">
        {children}
      </span>
    </div>
  );
}

function RowSelect(props: React.ComponentProps<typeof NativeSelect>) {
  return (
    <NativeSelect
      {...props}
      className="w-auto border-0 bg-transparent text-right shadow-none"
    />
  );
}

function StatusWord({
  status,
}: {
  status: ScheduledTaskView['status'] | ScheduledRunView['status'];
}) {
  const tone =
    status === 'active' || status === 'completed'
      ? 'text-emerald-700'
      : status === 'failed'
        ? 'text-destructive'
        : status === 'running' || status === 'dispatching'
          ? 'text-sky-700'
          : 'text-muted-foreground';
  return <span className={cn('text-sm', tone)}>{titleCase(status)}</span>;
}

function TaskDot({ status }: { status: ScheduledTaskView['status'] }) {
  if (status === 'paused')
    return <PauseIcon className="size-4 shrink-0 text-amber-600" />;
  if (status === 'archived')
    return <ArchiveIcon className="text-muted-foreground size-4 shrink-0" />;
  return (
    <CircleIcon
      className={cn(
        'size-4 shrink-0',
        status === 'active'
          ? 'text-muted-foreground'
          : 'text-muted-foreground/50',
      )}
    />
  );
}

function RunDot({ status }: { status: ScheduledRunView['status'] }) {
  const tone =
    status === 'completed'
      ? 'text-emerald-600'
      : status === 'failed'
        ? 'text-destructive'
        : status === 'cancelled'
          ? 'text-muted-foreground'
          : 'text-sky-600';
  return <CircleIcon className={cn('size-4 shrink-0', tone)} />;
}

function WorkspaceLoading() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function ListLoading() {
  return (
    <div className="grid gap-2 px-1 py-2">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="flex items-start gap-3 px-2 py-2">
          <Skeleton className="mt-0.5 size-4 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyInbox() {
  return (
    <Empty className="mt-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing to review</EmptyTitle>
        <EmptyDescription>
          Finished runs wait here until you mark them reviewed.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function EmptyTasks({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty className="mt-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarClockIcon />
        </EmptyMedia>
        <EmptyTitle>No scheduled tasks</EmptyTitle>
        <EmptyDescription>
          Create one with a five-field cron expression and a timezone.
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" onClick={onCreate}>
        Create
      </Button>
    </Empty>
  );
}

function blankDefinition(): ScheduleDefinitionInput {
  return {
    name: '',
    prompt: '',
    recurrence: '0 9 * * 1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    target: { kind: 'new-conversation' },
  };
}

function taskName(tasks: ScheduledTaskView[], taskId: string): string {
  return tasks.find(({ id }) => id === taskId)?.name ?? 'Purged task';
}

function taskSubtitle(task: ScheduledTaskView): string {
  const schedule = describe(task.recurrence);
  if (task.status === 'archived') return `${schedule} · Archived`;
  if (task.status === 'paused') return `${schedule} · Paused`;
  if (task.nextRunAt)
    return `${schedule} · Next run ${relative(task.nextRunAt)}`;
  return `${schedule} · No further runs`;
}

function reviewLabel(status: ScheduledRunView['reviewStatus']): string {
  if (status === 'pending_review') return 'Pending review';
  if (status === 'reviewed') return 'Reviewed';
  if (status === 'archived') return 'Archived';
  return 'Not reviewable yet';
}

function describe(recurrence: string): string {
  if (!isCron(recurrence)) {
    return recurrence.split('\n').at(-1)?.replace('RRULE:', '') ?? recurrence;
  }
  try {
    return cronstrue.toString(recurrence, { verbose: false });
  } catch {
    return 'Invalid cron expression';
  }
}

function isCron(recurrence: string): boolean {
  return !recurrence.includes('DTSTART');
}

function isTerminal(status: ScheduledRunView['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function matches(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

function short(value: string): string {
  return value.slice(0, 8);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function relative(value: number): string {
  const delta = value - Date.now();
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ] as const;
  for (const [unit, size] of units) {
    if (Math.abs(delta) >= size) {
      return format.format(Math.round(delta / size), unit);
    }
  }
  return format.format(Math.round(delta / 60_000), 'minute');
}

function absolute(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function compact(value: number): string {
  const delta = Date.now() - value;
  if (delta >= 2_592_000_000) return `${Math.round(delta / 2_592_000_000)}mo`;
  if (delta >= 86_400_000) return `${Math.round(delta / 86_400_000)}d`;
  if (delta >= 3_600_000) return `${Math.round(delta / 3_600_000)}h`;
  return `${Math.max(1, Math.round(delta / 60_000))}m`;
}
