import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  COPY_EXCLUSION_ATTRIBUTE,
  COPY_EXCLUSION_MODES,
  hasCopyExclusion,
  resolveCopyToClipboardStrategy,
  shouldIncludeInCopyImage,
} from './copy-image.ts';

describe('copy image helpers', () => {
  it('uses the shared attribute name for tokenized exclusions', () => {
    assert.equal(COPY_EXCLUSION_ATTRIBUTE, 'data-copy-exclude');
  });

  it('matches exact copy exclusion modes', () => {
    const node = {
      getAttribute(name: string) {
        return name === COPY_EXCLUSION_ATTRIBUTE
          ? COPY_EXCLUSION_MODES.assistantSnapshot
          : null;
      },
    };

    assert.equal(
      hasCopyExclusion(node, COPY_EXCLUSION_MODES.assistantSnapshot),
      true,
    );
    assert.equal(hasCopyExclusion(node, COPY_EXCLUSION_MODES.image), false);
  });

  it('matches tokenized multi-mode exclusions', () => {
    const node = {
      getAttribute(name: string) {
        return name === COPY_EXCLUSION_ATTRIBUTE
          ? `${COPY_EXCLUSION_MODES.image} ${COPY_EXCLUSION_MODES.assistantSnapshot}`
          : null;
      },
    };

    assert.equal(hasCopyExclusion(node, COPY_EXCLUSION_MODES.image), true);
    assert.equal(
      hasCopyExclusion(node, COPY_EXCLUSION_MODES.assistantSnapshot),
      true,
    );
    assert.equal(
      shouldIncludeInCopyImage(node, COPY_EXCLUSION_MODES.image),
      false,
    );
  });

  it('includes values that are not element-like', () => {
    assert.equal(
      shouldIncludeInCopyImage(null, COPY_EXCLUSION_MODES.image),
      true,
    );
    assert.equal(
      shouldIncludeInCopyImage({}, COPY_EXCLUSION_MODES.assistantSnapshot),
      true,
    );
  });

  it('prefers image copy when image clipboard APIs are available', () => {
    const strategy = resolveCopyToClipboardStrategy({
      clipboard: {
        write() {
          // noop
        },
        writeText() {
          // noop
        },
      },
      ClipboardItem: class ClipboardItem {},
    });

    assert.equal(strategy, 'image');
  });

  it('falls back to text copy when image clipboard APIs are unavailable', () => {
    const strategy = resolveCopyToClipboardStrategy({
      clipboard: {
        writeText() {
          // noop
        },
      },
    });

    assert.equal(strategy, 'text');
  });

  it('returns none when no clipboard copy APIs are available', () => {
    const strategy = resolveCopyToClipboardStrategy({
      clipboard: {},
    });

    assert.equal(strategy, 'none');
  });
});
