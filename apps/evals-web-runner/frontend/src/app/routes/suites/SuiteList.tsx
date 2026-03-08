import { Link } from 'react-router';

import { useData } from '../../hooks/use-client.ts';
import {
  Badge,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shadcn/index.ts';

export default function SuiteList() {
  const { data: suites, isLoading } = useData('GET /suites');

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold">Suites</h1>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !suites || suites.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-12 text-center">
          <p className="text-muted-foreground text-sm">No suites yet.</p>
          <Link
            to="/evals/new"
            className="text-primary mt-2 inline-block text-sm font-medium hover:underline"
          >
            Run your first eval
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-muted-foreground text-sm">
              {suites.length} suite{suites.length !== 1 ? 's' : ''}
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/evals/new">New Eval</Link>
            </Button>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Suite</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Running</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Last Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suites.map((suite) => (
                  <TableRow key={suite.id}>
                    <TableCell>
                      <Link
                        to={`/suites/${suite.id}`}
                        className="text-primary font-medium hover:underline"
                      >
                        {suite.name}
                      </Link>
                      <p className="text-muted-foreground text-xs">
                        Created {new Date(suite.created_at).toLocaleString()}
                      </p>
                    </TableCell>
                    <TableCell>{suite.runCount}</TableCell>
                    <TableCell>
                      {suite.runningCount > 0 ? (
                        <Badge variant="default">{suite.runningCount}</Badge>
                      ) : (
                        '0'
                      )}
                    </TableCell>
                    <TableCell>{suite.completedCount}</TableCell>
                    <TableCell>{suite.failedCount}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {suite.lastStartedAt
                        ? new Date(suite.lastStartedAt).toLocaleString()
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
