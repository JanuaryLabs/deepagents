import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, it } from 'node:test';

import { openapiSkill } from '@deepagents/context/openapi-skill';

describe('openapiSkill', () => {
  it('defaults the sandbox path to /skills/openapi', () => {
    const mount = openapiSkill();
    assert.equal(mount.sandbox, '/skills/openapi');
  });

  it('honors an explicit sandbox path override', () => {
    const mount = openapiSkill({ sandbox: '/custom/openapi' });
    assert.equal(mount.sandbox, '/custom/openapi');
  });

  it('returns a host directory containing openapi-cli/SKILL.md with valid frontmatter', () => {
    const mount = openapiSkill();
    assert.ok(isAbsolute(mount.host), 'host must be absolute');
    assert.ok(existsSync(mount.host), `host directory exists: ${mount.host}`);

    const skillPath = join(mount.host, 'openapi-cli', 'SKILL.md');
    assert.ok(existsSync(skillPath), `SKILL.md exists at: ${skillPath}`);

    const body = readFileSync(skillPath, 'utf8');
    assert.match(body, /^---/, 'starts with frontmatter delimiter');
    assert.match(body, /name:\s*openapi-cli/, 'has name field');
    assert.match(body, /description:/, 'has description field');
  });
});
