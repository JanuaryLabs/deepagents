#!/usr/bin/env node
import { Build, type Push, Step, prePush } from '@zukhruf/git-hooks';

class DocsReminder extends Step<Push> {
  readonly name = 'docs';

  async run() {
    return this.pass(
      'Run /update-docs to sync documentation with your changes',
    );
  }
}

await prePush([new Build(), new DocsReminder()]);
