import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { elementSchema, elementsSchema } from '@deepagents/elements';

describe('elementSchema', () => {
  it('accepts a minimal valid entry', () => {
    const result = elementSchema.safeParse({
      name: 'open-invoice',
      allowedAttributes: ['invoice-id'],
    });

    assert.equal(result.success, true);
  });

  it('accepts an entry with description', () => {
    const result = elementSchema.safeParse({
      name: 'add-to-cart',
      description: 'Add a product to the cart',
      allowedAttributes: ['sku', 'qty'],
    });

    assert.equal(result.success, true);
  });

  it('rejects a name with uppercase letters', () => {
    const result = elementSchema.safeParse({
      name: 'OpenInvoice',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects an empty name', () => {
    const result = elementSchema.safeParse({
      name: '',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects a name with leading hyphen', () => {
    const result = elementSchema.safeParse({
      name: '-leading-hyphen',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects a name that starts with a digit', () => {
    const result = elementSchema.safeParse({
      name: '1-leading-digit',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects a name with a trailing hyphen', () => {
    const result = elementSchema.safeParse({
      name: 'trailing-',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects a name with consecutive hyphens', () => {
    const result = elementSchema.safeParse({
      name: 'double--hyphen',
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects a name longer than 64 characters', () => {
    const result = elementSchema.safeParse({
      name: 'a'.repeat(65),
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects an entry whose allowedAttributes exceeds 20', () => {
    const result = elementSchema.safeParse({
      name: 'big',
      allowedAttributes: Array.from({ length: 21 }, (_, i) => `attr-${i}`),
    });

    assert.equal(result.success, false);
  });

  it('rejects an allowedAttributes entry longer than 64 characters', () => {
    const result = elementSchema.safeParse({
      name: 'long-attr',
      allowedAttributes: ['a'.repeat(65)],
    });

    assert.equal(result.success, false);
  });

  it('rejects an empty string inside allowedAttributes', () => {
    const result = elementSchema.safeParse({
      name: 'has-empty-attr',
      allowedAttributes: ['valid', ''],
    });

    assert.equal(result.success, false);
  });

  it('rejects an allowedAttributes entry that violates the kebab regex', () => {
    const result = elementSchema.safeParse({
      name: 'has-bad-attr',
      allowedAttributes: ['ValidAttr'],
    });

    assert.equal(result.success, false);
  });

  it('rejects an allowedAttributes entry with consecutive hyphens', () => {
    const result = elementSchema.safeParse({
      name: 'has-bad-attr',
      allowedAttributes: ['bad--attr'],
    });

    assert.equal(result.success, false);
  });

  it('rejects a description longer than 512 characters', () => {
    const result = elementSchema.safeParse({
      name: 'long-desc',
      description: 'x'.repeat(513),
      allowedAttributes: [],
    });

    assert.equal(result.success, false);
  });

  it('rejects an entry missing allowedAttributes', () => {
    const result = elementSchema.safeParse({
      name: 'no-attrs',
    });

    assert.equal(result.success, false);
  });

  it('rejects an allowedAttributes entry the sanitizer reserves (name)', () => {
    const result = elementSchema.safeParse({
      name: 'param-select',
      allowedAttributes: ['param', 'name'],
    });

    assert.equal(result.success, false);
  });
});

describe('elementsSchema', () => {
  it('accepts undefined', () => {
    const result = elementsSchema.safeParse(undefined);

    assert.equal(result.success, true);
  });

  it('accepts an empty array', () => {
    const result = elementsSchema.safeParse([]);

    assert.equal(result.success, true);
  });

  it('accepts up to 100 valid entries', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      name: `el-${i}`,
      allowedAttributes: ['a'],
    }));

    const result = elementsSchema.safeParse(entries);

    assert.equal(result.success, true);
  });

  it('rejects more than 100 entries', () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({
      name: `el-${i}`,
      allowedAttributes: ['a'],
    }));

    const result = elementsSchema.safeParse(entries);

    assert.equal(result.success, false);
  });

  it('rejects when any entry is invalid', () => {
    const result = elementsSchema.safeParse([
      { name: 'valid', allowedAttributes: [] },
      { name: 'INVALID', allowedAttributes: [] },
    ]);

    assert.equal(result.success, false);
  });
});
