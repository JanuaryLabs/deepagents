import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useData } from '../../hooks/use-client.ts';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shadcn/index.ts';

const PAGE_SIZE = 50;

function truncateValue(val: unknown, max = 120): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

export default function DatasetDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const decodedName = decodeURIComponent(name!);

  const [offset, setOffset] = useState(0);

  const { data: allDatasets } = useData('GET /datasets');

  const { data, isLoading } = useData('GET /datasets/{name}/rows', {
    name: decodedName,
    offset,
    limit: PAGE_SIZE,
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Dataset not found.</p>
      </div>
    );
  }

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < data.total;

  return (
    <div className="p-8">
      <div className="mb-6">
        <Breadcrumb className="mb-3">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/datasets">Datasets</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{decodedName}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{decodedName}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {data.total} rows
            </p>
          </div>
          {allDatasets && allDatasets.length > 1 && (
            <Select
              value={decodedName}
              onValueChange={(v) => {
                setOffset(0);
                navigate(`/datasets/${encodeURIComponent(v)}`);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allDatasets.map((ds) => (
                  <SelectItem key={ds.name} value={ds.name}>
                    {ds.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {data.total === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">
            This dataset is empty.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                {data.columns.map((col) => (
                  <TableHead key={col}>{col}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((_row, i) => {
                const row = _row as Record<string, unknown>;
                return (
                  <TableRow key={offset + i}>
                    <TableCell className="text-muted-foreground">
                      {offset + i + 1}
                    </TableCell>
                    {data.columns.map((col) => (
                      <TableCell
                        key={col}
                        className="max-w-xs truncate"
                        title={
                          typeof row[col] === 'string'
                            ? (row[col] as string)
                            : JSON.stringify(row[col])
                        }
                      >
                        {truncateValue(row[col])}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {data.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Showing {offset + 1}&ndash;
            {Math.min(offset + PAGE_SIZE, data.total)} of {data.total} rows
          </span>
          <div className="flex gap-2">
            {hasPrev && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
            )}
            {hasNext && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
