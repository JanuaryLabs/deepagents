import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  Button,
  Combobox,
  DirectionProvider,
  cn,
} from '@deepagents/react-shadcn';
import manifest from '@deepagents/react-shadcn/package.json' with { type: 'json' };

test('shadcn is importable through its public package export', () => {
  assert.equal(typeof Button, 'function');
  assert.equal(typeof Combobox, 'function');
  assert.equal(typeof DirectionProvider, 'function');
  assert.equal(cn('one', false, 'two'), 'one two');
  assert.equal(manifest.dependencies['@base-ui/react'], '^1.7.0');
  assert.equal(manifest.dependencies['radix-ui'], undefined);
});
