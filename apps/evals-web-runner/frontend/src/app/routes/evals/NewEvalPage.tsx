import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '../../components/ModelSelector.tsx';
import { useAction, useData } from '../../hooks/use-client.ts';
import { useModels } from '../../hooks/use-models.ts';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../../shadcn/index.ts';

const DETERMINISTIC_SCORERS = [
  { name: 'exactMatch', label: 'Exact Match' },
  { name: 'includes', label: 'Includes' },
  { name: 'levenshtein', label: 'Levenshtein' },
  { name: 'jsonMatch', label: 'JSON Match' },
];

const LLM_SCORERS = [{ name: 'factuality', label: 'Factuality' }];

export default function NewEvalPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromRunId = searchParams.get('from');
  const suiteId = searchParams.get('suiteId');

  const [name, setName] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [modelError, setModelError] = useState('');
  const [taskMode, setTaskMode] = useState<'prompt' | 'http'>('prompt');
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [selectedDataset, setSelectedDataset] = useState('');
  const [selectedScorers, setSelectedScorers] = useState<Set<string>>(
    new Set(),
  );
  const [scorerModel, setScorerModel] = useState('');
  const [scorerSelectorOpen, setScorerSelectorOpen] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState('10');
  const [timeout, setTimeout_] = useState('30000');
  const [trials, setTrials] = useState('1');
  const [threshold, setThreshold] = useState('0.5');
  const [batchSize, setBatchSize] = useState('');
  const [recordSelection, setRecordSelection] = useState('');
  const [inputField, setInputField] = useState('');
  const [expectedField, setExpectedField] = useState('');

  const { data: datasets } = useData('GET /datasets');
  const { data: prompts } = useData('GET /prompts');
  const {
    grouped: modelGroups,
    isLoading: modelsLoading,
    isError: modelsError,
  } = useModels();

  const { data: datasetPreview } = useData(
    'GET /datasets/{name}/rows',
    { name: selectedDataset, limit: 1 },
    { enabled: !!selectedDataset },
  );
  const datasetColumns = datasetPreview?.columns ?? [];

  const { data: prefillData } = useData(
    'GET /runs/{id}',
    { id: fromRunId! },
    {
      enabled: !!fromRunId,
    },
  );

  useEffect(() => {
    if (!prefillData) return;
    const cfg = (prefillData.run.config ?? {}) as Record<string, unknown>;
    setName(
      typeof cfg.suiteName === 'string' ? cfg.suiteName : prefillData.run.name,
    );
    setModels([prefillData.run.model]);
    setTaskMode(
      typeof cfg.taskMode === 'string' && cfg.taskMode === 'http'
        ? 'http'
        : 'prompt',
    );
    if (typeof cfg.promptId === 'string') setSelectedPromptId(cfg.promptId);
    if (typeof cfg.endpointUrl === 'string') setEndpointUrl(cfg.endpointUrl);
    if (typeof cfg.dataset === 'string') setSelectedDataset(cfg.dataset);
    if (Array.isArray(cfg.scorers))
      setSelectedScorers(new Set(cfg.scorers.map(String)));
    if (typeof cfg.scorerModel === 'string') setScorerModel(cfg.scorerModel);
    if (typeof cfg.maxConcurrency === 'number')
      setMaxConcurrency(String(cfg.maxConcurrency));
    if (typeof cfg.timeout === 'number') setTimeout_(String(cfg.timeout));
    if (typeof cfg.trials === 'number') setTrials(String(cfg.trials));
    if (typeof cfg.threshold === 'number') setThreshold(String(cfg.threshold));
    if (typeof cfg.batchSize === 'number') setBatchSize(String(cfg.batchSize));
    if (typeof cfg.recordSelection === 'string')
      setRecordSelection(cfg.recordSelection);
    if (typeof cfg.inputField === 'string') setInputField(cfg.inputField);
    if (typeof cfg.expectedField === 'string')
      setExpectedField(cfg.expectedField);
  }, [prefillData]);

  const sortedPrompts = useMemo(
    () => [...(prompts ?? [])].sort((a, b) => b.created_at - a.created_at),
    [prompts],
  );

  const selectedPromptContent = useMemo(() => {
    if (!selectedPromptId || !sortedPrompts.length) return '';
    return sortedPrompts.find((p) => p.id === selectedPromptId)?.content ?? '';
  }, [selectedPromptId, sortedPrompts]);

  const hasLlmScorer = [...selectedScorers].some((s) =>
    LLM_SCORERS.some((ls) => ls.name === s),
  );

  const submitMutation = useAction('POST /runs', {
    onSuccess: (data) => {
      navigate(`/suites/${data.suiteId}`);
    },
  });

  const handleModelSelect = useCallback(
    (modelId: string) => {
      setModelError('');
      if (!models.includes(modelId)) {
        setModels((prev) => [...prev, modelId]);
      }
      setModelSelectorOpen(false);
    },
    [models],
  );

  const handleScorerModelSelect = useCallback((modelId: string) => {
    setScorerModel(modelId);
    setScorerSelectorOpen(false);
  }, []);

  function removeModel(index: number) {
    setModels((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleScorer(name: string) {
    setSelectedScorers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (models.length === 0) {
      setModelError('Add at least one model before running the evaluation.');
      return;
    }

    submitMutation.mutate({
      suiteId: suiteId || undefined,
      name,
      models,
      taskMode,
      dataset: selectedDataset,
      recordSelection: recordSelection || undefined,
      scorers: [...selectedScorers],
      scorerModel: scorerModel || undefined,
      endpointUrl: taskMode === 'http' ? endpointUrl : undefined,
      promptId: taskMode === 'prompt' ? selectedPromptId : undefined,
      maxConcurrency: Number(maxConcurrency) || 10,
      batchSize: batchSize ? Number(batchSize) : undefined,
      timeout: Number(timeout) || 30000,
      trials: Number(trials) || 1,
      threshold: Number(threshold) || 0.5,
      inputField: inputField || undefined,
      expectedField: expectedField || undefined,
    });
  }

  if (fromRunId && !prefillData) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold">
        {suiteId ? 'Add Run to Suite' : 'New Evaluation'}
      </h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        <div>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. prompt-v2-gpt4o"
            required
            className="mt-1"
          />
        </div>

        <div>
          <Label>Models</Label>
          <div className="mt-1 space-y-2">
            {models.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {models.map((tag, i) => (
                  <Badge key={tag} variant="outline" className="gap-1">
                    {tag}
                    <button
                      type="button"
                      className="ml-1 text-xs"
                      onClick={() => removeModel(i)}
                      aria-label={`Remove model ${tag}`}
                    >
                      &times;
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <ModelSelector
              open={modelSelectorOpen}
              onOpenChange={setModelSelectorOpen}
            >
              <ModelSelectorTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={modelsLoading || modelsError}
                >
                  {modelsLoading
                    ? 'Loading models...'
                    : modelsError
                      ? 'Failed to load models'
                      : 'Select a model...'}
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent>
                <ModelSelectorInput placeholder="Search models..." />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  {modelGroups.map((group) => (
                    <ModelSelectorGroup
                      heading={group.providerName}
                      key={group.provider}
                    >
                      {group.models.map((model) => {
                        const modelSlug = model.id.includes('/')
                          ? model.id.split('/').pop()!
                          : model.id;
                        const fullId = `${group.provider}/${modelSlug}`;
                        return (
                          <ModelSelectorItem
                            key={fullId}
                            value={fullId}
                            onSelect={() => handleModelSelect(fullId)}
                          >
                            <ModelSelectorLogo provider={group.provider} />
                            <ModelSelectorName>{model.name}</ModelSelectorName>
                            {models.includes(fullId) && (
                              <span className="text-muted-foreground ml-auto text-xs">
                                added
                              </span>
                            )}
                          </ModelSelectorItem>
                        );
                      })}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
            {modelError && (
              <p className="text-destructive text-xs">{modelError}</p>
            )}
          </div>
        </div>

        <div>
          <Label>Task Mode</Label>
          <Tabs
            value={taskMode}
            onValueChange={(v) => setTaskMode(v as 'prompt' | 'http')}
            className="mt-1"
          >
            <TabsList>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="http">HTTP</TabsTrigger>
            </TabsList>

            <TabsContent value="prompt" className="mt-4 space-y-3">
              {sortedPrompts.length === 0 ? (
                <div className="rounded-md border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-900/20">
                  <p>
                    Prompt mode requires a saved prompt version.{' '}
                    <a href="/prompts" className="text-primary underline">
                      Create one in the prompt library
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <Label>Prompt Version</Label>
                    <Select
                      value={selectedPromptId}
                      onValueChange={setSelectedPromptId}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select a prompt..." />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedPrompts.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} (v{p.version})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Prompt Preview</Label>
                    <Textarea
                      value={selectedPromptContent}
                      readOnly
                      rows={8}
                      className="mt-1 font-mono"
                    />
                    <p className="text-muted-foreground mt-1 text-xs">
                      Prompt content is managed in the Prompt library. New runs
                      can only use saved versions.
                    </p>
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="http" className="mt-4">
              <div>
                <Label>Endpoint URL</Label>
                <Input
                  type="url"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="https://api.example.com/predict"
                  className="mt-1"
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  POST with JSON body. Expected response:{' '}
                  {'{ "output": "..." }'}
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div>
          <Label>Dataset</Label>
          {!datasets || datasets.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-sm">
              No datasets available.{' '}
              <a href="/datasets" className="text-primary underline">
                Upload one first
              </a>
              .
            </p>
          ) : (
            <Select value={selectedDataset} onValueChange={setSelectedDataset}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select a dataset..." />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((ds) => (
                  <SelectItem key={ds.name} value={ds.name}>
                    {ds.name} ({ds.extension})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedDataset && datasetColumns.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <Label>Input Column</Label>
                <Select value={inputField} onValueChange={setInputField}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="input" />
                  </SelectTrigger>
                  <SelectContent>
                    {datasetColumns.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Expected Column</Label>
                <Select value={expectedField} onValueChange={setExpectedField}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="expected" />
                  </SelectTrigger>
                  <SelectContent>
                    {datasetColumns.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <div>
          <Label>Scorers</Label>
          <div className="mt-2 space-y-3">
            <p className="text-muted-foreground text-xs uppercase">
              Deterministic
            </p>
            <div className="flex flex-wrap gap-4">
              {DETERMINISTIC_SCORERS.map((s) => (
                <label key={s.name} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedScorers.has(s.name)}
                    onCheckedChange={() => toggleScorer(s.name)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
            <p className="text-muted-foreground text-xs uppercase">LLM-Based</p>
            <div className="flex flex-wrap gap-4">
              {LLM_SCORERS.map((s) => (
                <label key={s.name} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedScorers.has(s.name)}
                    onCheckedChange={() => toggleScorer(s.name)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
            {hasLlmScorer && (
              <div>
                <Label>Scorer Model</Label>
                <ModelSelector
                  open={scorerSelectorOpen}
                  onOpenChange={setScorerSelectorOpen}
                >
                  <ModelSelectorTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-1 w-full justify-start"
                      disabled={modelsLoading || modelsError}
                    >
                      {scorerModel ? (
                        <>
                          <ModelSelectorLogo
                            provider={scorerModel.split('/')[0]!}
                          />
                          <ModelSelectorName>
                            {scorerModel}
                          </ModelSelectorName>
                        </>
                      ) : modelsLoading ? (
                        'Loading models...'
                      ) : modelsError ? (
                        'Failed to load models'
                      ) : (
                        'Select scorer model...'
                      )}
                    </Button>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent>
                    <ModelSelectorInput placeholder="Search models..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                      {modelGroups.map((group) => (
                        <ModelSelectorGroup
                          heading={group.providerName}
                          key={group.provider}
                        >
                          {group.models.map((model) => {
                            const modelSlug = model.id.includes('/')
                              ? model.id.split('/').pop()!
                              : model.id;
                            const fullId = `${group.provider}/${modelSlug}`;
                            return (
                              <ModelSelectorItem
                                key={fullId}
                                value={fullId}
                                onSelect={() =>
                                  handleScorerModelSelect(fullId)
                                }
                              >
                                <ModelSelectorLogo
                                  provider={group.provider}
                                />
                                <ModelSelectorName>
                                  {model.name}
                                </ModelSelectorName>
                                {scorerModel === fullId && (
                                  <span className="text-muted-foreground ml-auto text-xs">
                                    selected
                                  </span>
                                )}
                              </ModelSelectorItem>
                            );
                          })}
                        </ModelSelectorGroup>
                      ))}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              </div>
            )}
          </div>
        </div>

        <Accordion type="single" collapsible>
          <AccordionItem value="advanced">
            <AccordionTrigger className="text-sm font-medium">
              Advanced Options
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <Label>Max Concurrency</Label>
                  <Input
                    type="number"
                    value={maxConcurrency}
                    onChange={(e) => setMaxConcurrency(e.target.value)}
                    min="1"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Timeout (ms)</Label>
                  <Input
                    type="number"
                    value={timeout}
                    onChange={(e) => setTimeout_(e.target.value)}
                    min="1000"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Trials</Label>
                  <Input
                    type="number"
                    value={trials}
                    onChange={(e) => setTrials(e.target.value)}
                    min="1"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Threshold</Label>
                  <Input
                    type="number"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    min="0"
                    max="1"
                    step="0.05"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Batch Size (execution chunk)</Label>
                  <Input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(e.target.value)}
                    placeholder="All at once"
                    min="1"
                    className="mt-1"
                  />
                  <p className="text-muted-foreground mt-1 text-xs">
                    Controls how many records are processed per batch. It does
                    not limit total records.
                  </p>
                </div>
                <div className="col-span-2">
                  <Label>Run Specific Records (optional)</Label>
                  <Input
                    value={recordSelection}
                    onChange={(e) => setRecordSelection(e.target.value)}
                    placeholder="Examples: 1,2,8-12"
                    className="mt-1"
                  />
                  <p className="text-muted-foreground mt-1 text-xs">
                    Uses 1-based row numbers from the dataset preview.
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {submitMutation.error && (
          <p className="text-destructive text-sm">
            {submitMutation.error instanceof Error
              ? submitMutation.error.message
              : 'Failed to create evaluation.'}
          </p>
        )}

        <Button type="submit" disabled={submitMutation.isPending}>
          {submitMutation.isPending
            ? 'Starting Evaluation...'
            : 'Run Evaluation'}
        </Button>
      </form>
    </div>
  );
}
