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

3. **Push commits and tags**

   ```bash
   git push origin main --follow-tags
   ```

   The `release/*` tag will trigger the GitHub Actions workflow which builds and publishes all packages to npm.

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

If the tag was pushed but publishing failed, delete the tag and re-push:

```bash
git tag -d release/x.x.x
git push origin :refs/tags/release/x.x.x
git tag release/x.x.x
git push origin release/x.x.x
```
