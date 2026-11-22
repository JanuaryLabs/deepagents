# Maintainers Guide

## Release Process

Releases need no command. Each push to `main` starts the [Release workflow](.github/workflows/release.yml), which does not wait for CI: CI runs beside it and only reports, as in zukhruf. It releases what the conventional commits since the last `release/*` tag ask for:

1. zukhruf's `nx-release-version` action builds the public packages and writes the new version into the checkout of the runner only. It commits, tags and pushes nothing, so `main` gets no release commit and there is nothing to pull.
2. `npx nx run tools:check-consumer-install` packs the packages and installs them in a consumer.
3. zukhruf's `release-tag` action makes the tag `release/x.x.x` on the pushed commit through the GitHub API.
4. The packages are published to npm with provenance. A version that is already on npm is skipped.

A push with no `fix:`, `feat:`, `refactor:` or breaking commit since the last release changes nothing. The versions in the `package.json` files on `main` stay at 7.16.0, the last release that committed them: npm and the release tags hold the versions (`npm view @deepagents/<package> version`).

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

- **The run failed before the tag step** (npm authentication, the build, the consumer install check): nothing was tagged. Re-run the failed Release run from the Actions tab when the cause was outside the repo, or push the fix: the run of the next push releases these commits too.
- **The run failed after the tag step** (the publish): the tag is on the pushed commit, but npm does not have the version. If the cause is outside the repo (an npm or registry error), re-run the failed Release run from the Actions tab: it finds the tag on its commit and publishes that version. If the cause needs a change in the repo, push the fix: its run counts from that tag, so a `fix:` or `feat:` publishes the next version and the failed version is never published, and a `chore:` or `docs:` publishes nothing.
