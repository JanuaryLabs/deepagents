import { Hono } from 'hono';
import { raw } from 'hono/html';
import { Layout } from '../components/Layout.tsx';
import type { PromptRow } from '../../../store/index.ts';
import type { WebBindings } from '../types.ts';

const app = new Hono<WebBindings>();

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

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

interface PromptGroup {
  name: string;
  versions: PromptRow[];
}

app.get('/', (c) => {
  const store = c.get('store');
  const prompts = store.listPrompts();
  const byName = new Map<string, PromptRow[]>();
  for (const prompt of prompts) {
    const existing = byName.get(prompt.name) ?? [];
    existing.push(prompt);
    byName.set(prompt.name, existing);
  }
  const groups: PromptGroup[] = Array.from(byName.entries())
    .map(([name, versions]) => ({ name, versions }))
    .sort((a, b) => {
      const aLatest = a.versions[0]?.created_at ?? 0;
      const bLatest = b.versions[0]?.created_at ?? 0;
      return bLatest - aLatest;
    });

  const submitScript = raw(`<script>
document.addEventListener('submit', function(e) {
  var btn = e.target.querySelector('button[type="submit"]');
  if (btn) {
    btn.disabled = true;
    var spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-sm';
    btn.prepend(spinner);
  }
});

document.querySelectorAll('[data-use-version]').forEach(function(button) {
  button.addEventListener('click', function() {
    var name = button.getAttribute('data-name') || '';
    var content = button.getAttribute('data-content') || '';
    var nameInput = document.getElementById('prompt-name');
    var contentInput = document.getElementById('prompt-content');
    if (!nameInput || !contentInput) return;
    nameInput.value = name;
    contentInput.value = content;
    contentInput.focus();
    contentInput.selectionStart = contentInput.value.length;
    contentInput.selectionEnd = contentInput.value.length;
  });
});
</script>`);

  return c.render(
    <Layout title="Prompts">
      <form method="post" action="/api/prompts" class="mb-6 space-y-3 max-w-2xl">
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Name</legend>
          <input
            id="prompt-name"
            type="text"
            name="name"
            required
            placeholder="e.g. code-reviewer, summarizer"
            class="input input-sm w-full"
          />
        </fieldset>
        <fieldset class="fieldset">
          <legend class="fieldset-legend">Content (new version)</legend>
          <textarea
            id="prompt-content"
            name="content"
            required
            rows={4}
            placeholder="You are a helpful assistant that..."
            class="textarea w-full font-mono"
          />
          <p class="mt-1 text-xs text-base-content/60">
            Saving an existing prompt name creates the next version automatically.
          </p>
        </fieldset>
        <button type="submit" class="btn btn-neutral btn-sm">
          Save Version
        </button>
      </form>

      {groups.length === 0 ? (
        <div class="rounded-lg border-2 border-dashed border-base-content/20 p-12 text-center">
          <p class="text-sm text-base-content/60">No prompts saved yet.</p>
        </div>
      ) : (
        <div class="space-y-4">
          {groups.map((group) => (
            <div class="card bg-base-100 border border-base-content/10">
              <div class="card-body p-4">
                <div class="mb-3 flex items-center justify-between">
                  <div>
                    <h2 class="card-title text-sm">{group.name}</h2>
                    <p class="text-xs text-base-content/50">
                      {group.versions.length} version
                      {group.versions.length === 1 ? '' : 's'} · Latest:{' '}
                      {formatDate(group.versions[0]!.created_at)}
                    </p>
                  </div>
                  <span class="badge badge-outline badge-sm">
                    v{group.versions[0]!.version} latest
                  </span>
                </div>

                <div class="overflow-x-auto rounded-box border border-base-content/10">
                  <table class="table table-zebra table-sm">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Created</th>
                        <th>Preview</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.versions.map((p) => (
                        <tr>
                          <td class="font-medium">v{p.version}</td>
                          <td class="text-xs text-base-content/60">
                            {formatDateTime(p.created_at)}
                          </td>
                          <td class="text-xs font-mono text-base-content/70 max-w-2xl">
                            {truncate(p.content)}
                          </td>
                          <td>
                            <div class="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                class="btn btn-ghost btn-xs"
                                data-use-version
                                data-name={p.name}
                                data-content={p.content}
                              >
                                Use as base
                              </button>
                              <form
                                method="post"
                                action={`/api/prompts/${p.id}/delete`}
                                class="inline"
                              >
                                <button
                                  type="submit"
                                  class="btn btn-ghost btn-xs text-error"
                                >
                                  Delete
                                </button>
                              </form>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {submitScript}
    </Layout>,
  );
});

export default app;
