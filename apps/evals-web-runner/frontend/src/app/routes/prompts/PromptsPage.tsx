import { useState } from 'react';

import { useAction, useData } from '../../hooks/use-client.ts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '../../shadcn/index.ts';

interface PromptRow {
  id: string;
  name: string;
  version: number;
  content: string;
  created_at: number;
}

interface PromptGroup {
  name: string;
  versions: PromptRow[];
}

function groupPrompts(prompts: PromptRow[]): PromptGroup[] {
  const byName = new Map<string, PromptRow[]>();
  for (const prompt of prompts) {
    const existing = byName.get(prompt.name) ?? [];
    existing.push(prompt);
    byName.set(prompt.name, existing);
  }
  return Array.from(byName.entries())
    .map(([name, versions]) => ({ name, versions }))
    .sort((a, b) => {
      const aLatest = a.versions[0]?.created_at ?? 0;
      const bLatest = b.versions[0]?.created_at ?? 0;
      return bLatest - aLatest;
    });
}

function truncate(text: string, max = 150): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function PromptsPage() {
  const { data: prompts, isLoading } = useData('GET /prompts');

  const [promptName, setPromptName] = useState('');
  const [promptContent, setPromptContent] = useState('');

  const createMutation = useAction('POST /prompts', {
    invalidate: ['GET /prompts'],
    onSuccess: () => {
      setPromptName('');
      setPromptContent('');
    },
  });

  const deleteMutation = useAction('DELETE /prompts/{id}', {
    invalidate: ['GET /prompts'],
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (promptName.trim() && promptContent.trim()) {
      createMutation.mutate({ name: promptName, content: promptContent });
    }
  }

  function handleUseAsBase(name: string, content: string) {
    setPromptName(name);
    setPromptContent(content);
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full max-w-2xl" />
      </div>
    );
  }

  const groups = groupPrompts(prompts ?? []);

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold">Prompts</h1>

      <form onSubmit={handleCreate} className="mb-6 max-w-2xl space-y-3">
        <div>
          <label className="text-sm font-medium">Name</label>
          <Input
            value={promptName}
            onChange={(e) => setPromptName(e.target.value)}
            placeholder="e.g. code-reviewer, summarizer"
            required
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Content (new version)</label>
          <Textarea
            value={promptContent}
            onChange={(e) => setPromptContent(e.target.value)}
            placeholder="You are a helpful assistant that..."
            required
            rows={4}
            className="mt-1 font-mono"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Saving an existing prompt name creates the next version
            automatically.
          </p>
        </div>
        <Button type="submit" size="sm" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Saving...' : 'Save Version'}
        </Button>
      </form>

      {groups.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">No prompts saved yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const latestVersion = group.versions[0];
            if (!latestVersion) return null;

            return (
              <Card key={group.name}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm">{group.name}</CardTitle>
                      <p className="text-muted-foreground text-xs">
                        {group.versions.length} version
                        {group.versions.length === 1 ? '' : 's'} · Latest:{' '}
                        {formatDate(latestVersion.created_at)}
                      </p>
                    </div>
                    <Badge variant="outline">
                      v{latestVersion.version} latest
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Version</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Preview</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.versions.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell className="font-medium">
                              v{p.version}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {new Date(p.created_at).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-muted-foreground max-w-2xl font-mono text-xs">
                              {truncate(p.content)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    handleUseAsBase(p.name, p.content)
                                  }
                                >
                                  Use as base
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive"
                                  onClick={() =>
                                    deleteMutation.mutate({ id: p.id })
                                  }
                                  disabled={deleteMutation.isPending}
                                >
                                  Delete
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
