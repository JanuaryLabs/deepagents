#!/usr/bin/env node
import {
  NoAttributionTrailer,
  NoBreakingChange,
  NxReleaseScope,
  commitMsg,
} from '@zukhruf/git-hooks';

await commitMsg([
  new NxReleaseScope(),
  new NoBreakingChange(),
  new NoAttributionTrailer(),
]);
