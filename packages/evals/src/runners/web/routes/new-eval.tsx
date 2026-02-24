import { Hono } from 'hono';
import { raw } from 'hono/html';

import { Layout } from '../components/Layout.tsx';
import { listDatasets } from '../services/dataset-store.ts';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

const DETERMINISTIC_SCORERS = [
  { name: 'exactMatch', label: 'Exact Match' },
  { name: 'includes', label: 'Includes' },
  { name: 'levenshtein', label: 'Levenshtein' },
  { name: 'jsonMatch', label: 'JSON Match' },
];

const LLM_SCORERS = [{ name: 'factuality', label: 'Factuality' }];

app.get('/', (c) => {
  const store = c.get('store');
  const datasets = listDatasets();
  const prompts = [...store.listPrompts()].sort(
    (a, b) => b.created_at - a.created_at,
  );

  const tabScript = raw(`<script>
(function() {
  var tabs = document.querySelectorAll('[data-tab]');
  var panels = document.querySelectorAll('[data-panel]');
  var promptPicker = document.getElementById('promptPicker');
  var endpointInput = document.querySelector('input[name="endpointUrl"]');
  function syncMode(target) {
    if (promptPicker) promptPicker.disabled = target !== 'prompt';
    if (endpointInput) endpointInput.disabled = target !== 'http';
  }
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      var target = tab.getAttribute('data-tab');
      tabs.forEach(function(t) {
        t.classList.toggle('tab-active', t.getAttribute('data-tab') === target);
      });
      panels.forEach(function(p) {
        p.classList.toggle('hidden', p.getAttribute('data-panel') !== target);
      });
      document.getElementById('taskMode').value = target;
      syncMode(target);
    });
  });
  if (!promptPicker) {
    var httpTab = document.querySelector('[data-tab="http"]');
    if (httpTab) httpTab.click();
  }
  syncMode(document.getElementById('taskMode').value);

  var llmChecks = document.querySelectorAll('[data-llm-scorer]');
  var scorerModelGroup = document.getElementById('scorer-model-group');
  function updateScorerModel() {
    var anyChecked = false;
    llmChecks.forEach(function(cb) { if (cb.checked) anyChecked = true; });
    scorerModelGroup.classList.toggle('hidden', !anyChecked);
  }
  llmChecks.forEach(function(cb) { cb.addEventListener('change', updateScorerModel); });
  updateScorerModel();

  var preview = document.getElementById('systemPromptPreview');
  function updatePromptPreview() {
    if (!promptPicker || !preview) return;
    var selectedOption = promptPicker.options[promptPicker.selectedIndex];
    preview.value = selectedOption ? (selectedOption.getAttribute('data-content') || '') : '';
  }
  if (promptPicker && preview) {
    promptPicker.addEventListener('change', updatePromptPreview);
    updatePromptPreview();
  }

  var modelInput = document.getElementById('modelTagInput');
  var modelTagsList = document.getElementById('modelTags');
  var modelHiddenInputs = document.getElementById('modelHiddenInputs');
  var modelError = document.getElementById('modelError');
  var modelTags = [];

  function isValidModelTag(value) {
    return /^[^\\s/]+\\/[^\\s/].+$/.test(value);
  }

  function clearModelError() {
    if (!modelError) return;
    modelError.textContent = '';
    modelError.classList.add('hidden');
  }

  function setModelError(message) {
    if (!modelError) return;
    modelError.textContent = message;
    modelError.classList.remove('hidden');
  }

  function renderModelTags() {
    if (!modelTagsList || !modelHiddenInputs) return;
    modelTagsList.innerHTML = '';
    modelHiddenInputs.innerHTML = '';

    modelTags.forEach(function(tag, index) {
      var chip = document.createElement('span');
      chip.className = 'badge badge-outline badge-sm gap-1';
      chip.textContent = tag;

      var removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn btn-ghost btn-xs btn-circle';
      removeButton.textContent = '×';
      removeButton.setAttribute('aria-label', 'Remove model ' + tag);
      removeButton.addEventListener('click', function() {
        modelTags.splice(index, 1);
        renderModelTags();
      });

      chip.appendChild(removeButton);
      modelTagsList.appendChild(chip);

      var hiddenInput = document.createElement('input');
      hiddenInput.type = 'hidden';
      hiddenInput.name = 'models';
      hiddenInput.value = tag;
      modelHiddenInputs.appendChild(hiddenInput);
    });
  }

  function addModelTag(rawValue) {
    var value = (rawValue || '').trim();
    if (!value) return;

    if (!isValidModelTag(value)) {
      setModelError('Invalid model format. Use provider/model-id (e.g. openai/gpt-4o).');
      return;
    }

    clearModelError();
    if (modelTags.includes(value)) return;
    modelTags.push(value);
    renderModelTags();
  }

  if (modelInput) {
    modelInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addModelTag(modelInput.value);
        modelInput.value = '';
      }
    });
    modelInput.addEventListener('blur', function() {
      if (!modelInput.value.trim()) return;
      addModelTag(modelInput.value);
      modelInput.value = '';
    });
  }

  document.addEventListener('submit', function(e) {
    if (modelInput && modelInput.value.trim()) {
      addModelTag(modelInput.value);
      modelInput.value = '';
    }

    if (modelTags.length === 0) {
      e.preventDefault();
      setModelError('Add at least one model before running the evaluation.');
      if (modelInput) modelInput.focus();
      return;
    }

    clearModelError();
    renderModelTags();

    var btn = e.target.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      var spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-sm';
      btn.prepend(spinner);
    }
  });
})();
</script>`);

  return c.render(
    <Layout title="New Evaluation">
      <form method="post" action="/api/runs" class="max-w-2xl space-y-6">
        <input type="hidden" name="taskMode" id="taskMode" value="prompt" />

        <fieldset class="fieldset">
          <legend class="fieldset-legend">Name</legend>
          <input
            type="text"
            name="name"
            required
            placeholder="e.g. prompt-v2-gpt4o"
            class="input input-sm w-full"
          />
        </fieldset>

        <fieldset class="fieldset">
          <legend class="fieldset-legend">Models</legend>
          <div class="space-y-2">
            <div id="modelTags" class="flex flex-wrap gap-2"></div>
            <input
              type="text"
              id="modelTagInput"
              placeholder="Type provider/model-id and press Enter"
              class="input input-sm w-full"
            />
            <div id="modelHiddenInputs"></div>
            <p id="modelError" class="text-error hidden text-xs"></p>
          </div>
          <p class="text-base-content/60 mt-1 text-xs">
            Add one or more models. Duplicate tags are ignored.
          </p>
        </fieldset>

        <fieldset class="fieldset">
          <legend class="fieldset-legend">Task Mode</legend>
          <div role="tablist" class="tabs tabs-border">
            <button
              type="button"
              data-tab="prompt"
              role="tab"
              class="tab tab-active"
            >
              Prompt
            </button>
            <button type="button" data-tab="http" role="tab" class="tab">
              HTTP
            </button>
          </div>

          <div data-panel="prompt" class="mt-4">
            {prompts.length === 0 ? (
              <div class="border-warning/30 bg-warning/10 rounded-md border p-4 text-sm">
                <p>
                  Prompt mode requires a saved prompt version.{' '}
                  <a href="/prompts" class="link link-primary">
                    Create one in the prompt library
                  </a>
                  .
                </p>
              </div>
            ) : (
              <>
                <fieldset class="fieldset mb-3">
                  <legend class="fieldset-legend">Prompt Version</legend>
                  <select
                    id="promptPicker"
                    name="promptId"
                    required
                    class="select select-sm w-full"
                  >
                    {prompts.map((p, idx) => (
                      <option
                        value={p.id}
                        data-content={p.content}
                        selected={idx === 0}
                      >
                        {p.name} (v{p.version})
                      </option>
                    ))}
                  </select>
                </fieldset>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Prompt Preview</legend>
                  <textarea
                    id="systemPromptPreview"
                    rows={8}
                    readOnly
                    class="textarea w-full font-mono"
                  />
                  <p class="text-base-content/60 mt-1 text-xs">
                    Prompt content is managed in the Prompt library. New runs
                    can only use saved versions.
                  </p>
                </fieldset>
              </>
            )}
          </div>

          <div data-panel="http" class="mt-4 hidden">
            <fieldset class="fieldset">
              <legend class="fieldset-legend">Endpoint URL</legend>
              <input
                type="url"
                name="endpointUrl"
                placeholder="https://api.example.com/predict"
                class="input input-sm w-full"
              />
              <p class="text-base-content/60 mt-1 text-xs">
                POST with JSON body. Expected response: {'{ "output": "..." }'}
              </p>
            </fieldset>
          </div>
        </fieldset>

        <fieldset class="fieldset">
          <legend class="fieldset-legend">Dataset</legend>
          {datasets.length === 0 ? (
            <p class="text-base-content/60 text-sm">
              No datasets available.{' '}
              <a href="/datasets" class="link link-primary">
                Upload one first
              </a>
              .
            </p>
          ) : (
            <select name="dataset" required class="select select-sm w-full">
              {datasets.map((ds) => (
                <option value={ds.name}>
                  {ds.name} ({ds.extension})
                </option>
              ))}
            </select>
          )}
        </fieldset>

        <fieldset class="fieldset">
          <legend class="fieldset-legend">Scorers</legend>
          <div class="space-y-2">
            <p class="text-base-content/60 text-xs uppercase">Deterministic</p>
            <div class="flex flex-wrap gap-4">
              {DETERMINISTIC_SCORERS.map((s) => (
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="scorers"
                    value={s.name}
                    class="checkbox checkbox-sm"
                  />
                  {s.label}
                </label>
              ))}
            </div>
            <p class="text-base-content/60 mt-3 text-xs uppercase">LLM-Based</p>
            <div class="flex flex-wrap gap-4">
              {LLM_SCORERS.map((s) => (
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="scorers"
                    value={s.name}
                    data-llm-scorer
                    class="checkbox checkbox-sm"
                  />
                  {s.label}
                </label>
              ))}
            </div>
            <fieldset id="scorer-model-group" class="fieldset mt-2 hidden">
              <legend class="fieldset-legend">Scorer Model</legend>
              <input
                type="text"
                name="scorerModel"
                placeholder="OpenAI-compatible model id (e.g. gpt-4.1-mini)"
                class="input input-sm w-full"
              />
            </fieldset>
          </div>
        </fieldset>

        <div class="collapse-arrow border-base-content/10 bg-base-100 collapse border">
          <input type="checkbox" />
          <div class="collapse-title text-sm font-medium">Advanced Options</div>
          <div class="collapse-content">
            <div class="grid grid-cols-2 gap-4">
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Max Concurrency</legend>
                <input
                  type="number"
                  name="maxConcurrency"
                  value="10"
                  min="1"
                  class="input input-sm w-full"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Timeout (ms)</legend>
                <input
                  type="number"
                  name="timeout"
                  value="30000"
                  min="1000"
                  class="input input-sm w-full"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Trials</legend>
                <input
                  type="number"
                  name="trials"
                  value="1"
                  min="1"
                  class="input input-sm w-full"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">Threshold</legend>
                <input
                  type="number"
                  name="threshold"
                  value="0.5"
                  min="0"
                  max="1"
                  step="0.05"
                  class="input input-sm w-full"
                />
              </fieldset>
              <fieldset class="fieldset">
                <legend class="fieldset-legend">
                  Batch Size (execution chunk)
                </legend>
                <input
                  type="number"
                  name="batchSize"
                  placeholder="All at once"
                  min="1"
                  class="input input-sm w-full"
                />
                <p class="text-base-content/60 mt-1 text-xs">
                  Controls how many records are processed per batch. It does not
                  limit total records.
                </p>
              </fieldset>
              <fieldset class="fieldset col-span-2">
                <legend class="fieldset-legend">
                  Run Specific Records (optional)
                </legend>
                <input
                  type="text"
                  name="recordSelection"
                  placeholder="Examples: 1,2,8-12"
                  class="input input-sm w-full"
                />
                <p class="text-base-content/60 mt-1 text-xs">
                  Uses 1-based row numbers from the dataset preview.
                </p>
              </fieldset>
            </div>
          </div>
        </div>

        <button type="submit" class="btn btn-neutral">
          Run Evaluation
        </button>
      </form>

      {tabScript}
    </Layout>,
  );
});

export default app;
