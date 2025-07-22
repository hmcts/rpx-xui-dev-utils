# removeRepoSecrets

A utility for removing secrets from git repositories using `git-filter-repo`. Searches a set of git repos for specific secret strings and replaces them with \*\*\*REMOVED\*\*\*

## Prerequisites

- Node.js
- [git-filter-repo](https://github.com/newren/git-filter-repo) installed and available in your PATH. For Mac users install with brew install git-filter-repo.

## Setup

1. Clone this repository.
2. Create a .txt file for each repository in the secrets/ directory, containing the sensitive strings to remove (one secret per line).
3. Edit `config.json` to specify for each repo that you wish to clean:
   - "name": A label for the repo to clean
   - "path": A relative or absolute path to the root of clone of the repo to clean. If a relative path is used it should be relative to the removeRepoSecrets directory
   - "secrets_file": A relative or absolute path to a file containing the secret text to be replaced, one replacement per line
   - "url": The git remote url for the repo, for example git@github.com:hmcts/rpx-xui-node-lib.git
## Usage

From the `removeRepoSecrets` directory, run:

```sh
node secrets-removal.js
```

This will:
- Backup each repository to the specified backup directory
- Remove secrets listed in the provided secrets files
- Force-push the cleaned history to the remote

## Post Cleanup Actions

- Verify pushed changes on GitHub.
- Inform all team members immediately after cleanup.
- All users must discard their old local clones and re-clone the cleaned repository:
  ```sh
  git clone <repo-url>
  ```
- Verify CI/CD pipelines to ensure they work with the updated repository.
- Update this documentation for any actions that are missing

## Recovering a Repository from Backup (Force Push)

1. Change directory to the backup you want to restore:
   ```sh
   cd ./backup/<repo_name>_<timestamp>
   ```
2. (Optional) Set the remote URL to your GitHub repository if not already set:
   ```sh
   git remote add origin <repo-url>
   # or update if it already exists
   git remote set-url origin <repo-url>
   ```
3. Force push the backup to overwrite the remote repository on GitHub:
   ```sh
   git push origin --force --all 
   git push origin --force --tags
   ```
