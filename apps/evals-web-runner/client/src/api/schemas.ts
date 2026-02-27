import compare from './compare.ts';
import datasets from './datasets.ts';
import models from './models.ts';
import prompts from './prompts.ts';
import runs from './runs.ts';
import suites from './suites.ts';

export default {
  ...suites,
  ...runs,
  ...datasets,
  ...prompts,
  ...compare,
  ...models,
};
