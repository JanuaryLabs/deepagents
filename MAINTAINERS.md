# Maintainers Guide

## Release Process

Releases are automated via GitHub Actions. When a release tag is pushed, CI will build and publish all packages to npm.

### Prerequisites

- You must have push access to the `main` branch
- All CI checks must be passing on `main`

### Steps to Release

1. **Pull the latest main branch**

   ```bash
   git checkout main
   git pull origin main
   ```

2. **Run the release command**

   This will analyze commits since the last release, bump versions based on conventional commits, update changelogs, and create a git tag.

   ```bash
   npx nx release --skip-publish
   ```

   Review the proposed version bumps and confirm when prompted.

3. **Push the commit, then the tag**

   Push `main`. Wait for green CI. Then push only the new tag:

   ```bash
   git push origin main
   git push origin refs/tags/release/x.x.x
   ```

   The `release/*` tag starts the GitHub Actions workflow. The workflow builds all packages and publishes them to npm.

   Do not use `--follow-tags`. It also pushes older local tags. GitHub sends no push event when one push has more than three tags, so the workflow does not start and npm gets no release.

4. **Verify the release**
   - Check the [Actions tab](../../actions) for the release workflow status
   - Verify packages are published on [npm](https://www.npmjs.com/org/deepagents)

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

To preview what a release would do without making changes:

```bash
npx nx release --skip-publish --dry-run
```

### Troubleshooting

**Release workflow failed?**

1. Check the workflow logs in the Actions tab
2. Common issues:
   - `NPM_ACCESS_TOKEN` secret is invalid or expired
   - Package with same version already exists on npm
   - Build failures

**Need to republish a failed release?**

Do this only for the newest release. Do not push an older tag again: the workflow publishes that version, and the `latest` dist-tag on npm can move back to it. For example, `release/6.2.0` is not on npm.

If you pushed the newest tag and publishing failed, delete the tag and push it again:

```bash
git tag -d release/x.x.x
git push origin :refs/tags/release/x.x.x
git tag release/x.x.x
git push origin release/x.x.x
```
