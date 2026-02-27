import { useState } from 'react';
import { Link } from 'react-router';

import { useAction, useData } from '../../hooks/use-client.ts';
import { formatSize } from '../../lib/format.ts';
import {
  Badge,
  Button,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shadcn/index.ts';

export default function DatasetListPage() {
  const { data: datasets, isLoading } = useData('GET /datasets');

  const [hfDataset, setHfDataset] = useState('');
  const [hfConfig, setHfConfig] = useState('default');
  const [hfSplit, setHfSplit] = useState('train');

  const uploadMutation = useAction('POST /datasets', {
    invalidate: ['GET /datasets'],
  });

  const hfMutation = useAction('POST /datasets/import-hf', {
    invalidate: ['GET /datasets'],
    onSuccess: () => {
      setHfDataset('');
    },
  });

  const deleteMutation = useAction('DELETE /datasets/{name}', {
    invalidate: ['GET /datasets'],
  });

  function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    uploadMutation.mutate({ file: formData.get('file') as never });
    e.currentTarget.reset();
  }

  function handleHfAdd(e: React.FormEvent) {
    e.preventDefault();
    if (hfDataset.trim()) {
      hfMutation.mutate({
        dataset: hfDataset,
        config: hfConfig,
        split: hfSplit,
      });
    }
  }

  function isHfDataset(name: string): boolean {
    return name.endsWith('.hf.json');
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold">Datasets</h1>

      <div className="mb-6 space-y-4">
        <form onSubmit={handleUpload} className="flex items-end gap-4">
          <div>
            <label className="text-sm font-medium">Upload Dataset</label>
            <Input
              type="file"
              name="file"
              accept=".json,.jsonl,.csv"
              required
              className="mt-1"
            />
          </div>
          <Button type="submit" size="sm" disabled={uploadMutation.isPending}>
            {uploadMutation.isPending ? 'Uploading...' : 'Upload'}
          </Button>
        </form>

        <form onSubmit={handleHfAdd} className="flex items-end gap-4">
          <div>
            <label className="text-sm font-medium">Add from HuggingFace</label>
            <Input
              value={hfDataset}
              onChange={(e) => setHfDataset(e.target.value)}
              placeholder="e.g. squad, glue"
              required
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Config</label>
            <Input
              value={hfConfig}
              onChange={(e) => setHfConfig(e.target.value)}
              className="mt-1 w-32"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Split</label>
            <Input
              value={hfSplit}
              onChange={(e) => setHfSplit(e.target.value)}
              className="mt-1 w-24"
            />
          </div>
          <Button type="submit" size="sm" disabled={hfMutation.isPending}>
            {hfMutation.isPending ? 'Adding...' : 'Add'}
          </Button>
        </form>
      </div>

      {!datasets || datasets.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">
            No datasets uploaded yet.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Size</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {datasets.map((ds) => (
                <TableRow key={ds.name}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/datasets/${encodeURIComponent(ds.name)}`}
                      className="text-primary hover:underline"
                    >
                      {ds.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isHfDataset(ds.name) ? (
                      <Badge variant="outline">HuggingFace</Badge>
                    ) : (
                      ds.extension
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {isHfDataset(ds.name) ? '\u2014' : formatSize(ds.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => deleteMutation.mutate({ name: ds.name })}
                      disabled={deleteMutation.isPending}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
