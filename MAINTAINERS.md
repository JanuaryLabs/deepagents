# Maintainers Guide

## Release Process

Releases need no command. When CI passes for a push to `main`, the [Release workflow](.github/workflows/release.yml) releases what the conventional commits since the last `release/*` tag ask for:

1. It checks that `main` is still the commit that CI tested. If a newer commit is on `main`, it stops: the run of the newer commit releases it.
2. `npx nx release version` builds the public packages, sets the new version, then commits, tags (`release/x.x.x`) and pushes the release commit to `main`.
3. `npx nx run tools:check-consumer-install` packs the packages and installs them in a consumer.
4. The packages are published to npm with provenance. A version that is already on npm is skipped.

A push with no `fix:`, `feat:`, `refactor:` or breaking commit since the last release changes nothing. The release commit and tag are pushed with `GITHUB_TOKEN`, so they start no CI run.

To release, merge or push conventional commits to `main`, then check the [Actions tab](../../actions) and [npm](https://www.npmjs.com/org/deepagents).

### Version Bumping

Versions are determined automatically from commit messages using [Conventional Commits](https://www.conventionalcommits.org/):

| Commit Type               | Version Bump                    |
| ------------------------- | ------------------------------- |
| `fix:`                    | Patch                           |
| `feat:`                   | Minor                           |
| `BREAKING CHANGE:` or `!` | Major                           |
| `refactor:`               | Patch                           |
| `chore:`                  | No bump (hidden from changelog) |

### Dry Run

To preview the next version without making changes:

```bash
npx nx release version --dry-run
```

### Troubleshooting

**Release workflow failed?**

Check the workflow logs in the Actions tab. Common issues:

- `NPM_ACCESS_TOKEN` secret is invalid or expired
- Build failures
- The consumer install check failed before the publish: a consumer of the packed packages gets `ERESOLVE`, or more than one copy of `ai` or `react`. A new `ai` or `react` on npm can cause this with no change in this repo. Run `npx nx run tools:check-consumer-install` to see the conflict.

**What to do when a release fails**

The publish step already retries once the packages that the first attempt did not publish (for example, after a sigstore Rekor 409). Do not push or delete `release/*` tags by hand.

- **The run failed before the Version step** (npm authentication, the build): nothing was tagged. Fix the cause and re-run the failed Release run from the Actions tab. If a newer commit is already on `main`, the re-run stops, and the run of that commit releases instead.
- **The run failed after the Version step** (the consumer install check or the publish): the release commit and tag are on `main`, but npm does not have the version. A re-run of that Release run stops, because `main` is now the release commit, not the commit that CI tested. Push the fix to `main`. When CI passes, its Release run publishes: if the fix is a `chore:` or `docs:` commit, it publishes the version that failed; if it is a `fix:` or `feat:` commit, it publishes the next version, and the failed version is never published.
