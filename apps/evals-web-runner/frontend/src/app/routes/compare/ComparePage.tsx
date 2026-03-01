import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { ComparisonTable } from '../../components/ComparisonTable.tsx';
import { useData } from '../../hooks/use-client.ts';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '../../shadcn/index.ts';

interface RunRow {
  id: string;
  name: string;
  model: string;
  started_at: number;
}

interface ComparisonResponse {
  baseline: RunRow;
  candidate: RunRow;
  result: {
    caseDiffs: Array<{
      index: number;
      scorerDeltas: Record<
        string,
        { baseline: number; candidate: number; delta: number; change: string }
      >;
    }>;
    scorerSummaries: Record<
      string,
      {
        meanDelta: number;
        improvedCount: number;
        regressedCount: number;
        unchangedCount: number;
      }
    >;
    costDelta: {
      latencyDeltaMs: number;
      tokenInDelta: number;
      tokenOutDelta: number;
    };
    totalCasesCompared: number;
    regression: {
      regressed: boolean;
      details: Record<string, { meanDelta: number; exceeds: boolean }>;
    };
  };
}

export default function ComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const baselineParam = searchParams.get('baseline') ?? '';
  const candidateParam = searchParams.get('candidate') ?? '';

  const [selectedBaseline, setSelectedBaseline] = useState(baselineParam);
  const [selectedCandidate, setSelectedCandidate] = useState(candidateParam);

  const { data: completedRuns, isLoading: runsLoading } =
    useData('GET /compare/runs');
  const {
    data: comparison,
    isLoading: compareLoading,
    error: compareError,
  } = useData(
    'GET /compare',
    {
      baseline: baselineParam,
      candidate: candidateParam,
    },
    { enabled: !!baselineParam && !!candidateParam },
  );

  function handleCompare() {
    if (selectedBaseline && selectedCandidate) {
      setSearchParams({
        baseline: selectedBaseline,
        candidate: selectedCandidate,
      });
    }
  }

  if (runsLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full max-w-lg" />
      </div>
    );
  }

  const hasParams = !!baselineParam && !!candidateParam;

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold">Compare Runs</h1>

      <div className="mb-8 max-w-lg space-y-4">
        <div>
          <label className="text-sm font-medium">Baseline Run</label>
          <Select value={selectedBaseline} onValueChange={setSelectedBaseline}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select a run..." />
            </SelectTrigger>
            <SelectContent>
              {completedRuns?.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name} — {r.model} (
                  {new Date(r.started_at).toLocaleDateString()})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium">Candidate Run</label>
          <Select
            value={selectedCandidate}
            onValueChange={setSelectedCandidate}
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select a run..." />
            </SelectTrigger>
            <SelectContent>
              {completedRuns?.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name} — {r.model} (
                  {new Date(r.started_at).toLocaleDateString()})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={handleCompare}
          disabled={!selectedBaseline || !selectedCandidate}
        >
          Compare
        </Button>
      </div>

      {hasParams && compareLoading && (
        <div className="space-y-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {hasParams && compareError && (
        <p className="text-destructive text-sm">
          {compareError instanceof Error
            ? compareError.message
            : 'Failed to compare runs.'}
        </p>
      )}

      {comparison && (
        <div>
          <div className="mb-6">
            <p className="text-muted-foreground text-sm">
              <span className="font-medium">{comparison.baseline.name}</span> (
              {comparison.baseline.model}){' vs '}
              <span className="font-medium">{comparison.candidate.name}</span> (
              {comparison.candidate.model})
            </p>
          </div>
          <ComparisonTable result={comparison.result} />
        </div>
      )}
    </div>
  );
}
