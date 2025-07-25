# removeRepoSecrets

A utility for removing secrets from git repositories using `git-filter-repo`. Searches a set of git repos for specific secret strings and replaces them with \*\*\*REMOVED\*\*\*.

## Modes of Operation

The script can be run in three different modes:

### analysis (default) 
No changes will be made to the local repositories. The script creates a temporary copy of each repository, applies the secrets removal process to it, and generates a diff showing what would change. The diff is saved as a file and also displayed in the browser using diff2html. This allows you to review the changes before they are actually made.

### update
Creates a backup of each repository, then modifies each local repository by rewriting its git history to remove the specified secrets. After the update completes successfully, the script will display instructions on how to manually push the changes to the remote repository if desired. This mode requires confirmation before proceeding with local history rewriting.

### update-and-push
Creates a backup of each repository, modifies the local repository by rewriting its git history to remove the specified secrets, and then force-pushes the changes to the remote repository. This mode requires confirmation before proceeding, as it will affect all users who have cloned or pulled from the repository. Use with extreme caution as it permanently alters the remote git history.

## Prerequisites

- Node.js
- [git-filter-repo](https://github.com/newren/git-filter-repo) installed and available in your PATH. For Mac users install with brew install git-filter-repo.
- [diff2html-cli](https://github.com/rtfpessoa/diff2html-cli) for viewing diffs in the browser (installed as part of npm dependencies)

## Setup

1. Clone this repository:
   ```sh
   git clone https://github.com/hmcts/rpx-xui-dev-utils.git
   cd rpx-xui-dev-utils/removeRepoSecrets
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create a .txt file for each repository in the secrets/ directory, containing the sensitive strings to remove (one secret per line).
4. Edit `config.json` to specify for each repo that you wish to clean:
   - "name": A label for the repo to clean
   - "path": A relative or absolute path to the root of clone of the repo to clean. If a relative path is used it should be relative to the removeRepoSecrets directory
   - "secrets_file": A relative or absolute path to a file containing the secret text to be replaced, one replacement per line
   - "url": The git remote url for the repo, for example git@github.com:hmcts/rpx-xui-node-lib.git

## Usage

From the `removeRepoSecrets` directory, run:

```sh
node secrets-removal.js [mode]
```

Where [mode] is one of:

- analysis (default) - Analyzes repositories without making changes
- update - Updates local repositories only
- update-and-push - Updates local repositories and pushes to remote

### Examples:

```sh
# Run in analysis mode (default)
node secrets-removal.js

# Update local repositories only
node secrets-removal.js update

# Update local and push to remote
node secrets-removal.js update-and-push
```

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
