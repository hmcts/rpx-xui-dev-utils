# @hmcts/pr-bot

A bot to use within GitHub Actions that posts contextual information about pull requests to Slack.

## Installation

```bash
npm install @hmcts/pr-bot
```

## Usage

### As a CLI tool

```bash
npx pr-bot
```

### Programmatically

```javascript
const prBot = require('@hmcts/pr-bot');
prBot.run();
```

### Example Use In GitHub Actions Workflow

```yaml
name: pr-bot
on:
  pull_request:
    types: [opened, closed, reopened, labeled, unlabeled]
  pull_request_review:
    types: [submitted]
  status:

permissions:
    contents: read
    pull-requests: write
    issues: write
    statuses: read

jobs:
  slack-notification:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout respository
        uses: actions/checkout@v4
      
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Azure CLI script
        uses: azure/cli@v2
        with:
          azcliversion: latest
          inlineScript: |
            # Log in to Azure using service principal
            az login --service-principal --username ${{ secrets.AZURE_CLIENT_ID }} --password ${{ secrets.AZURE_CLIENT_SECRET }} --tenant ${{ secrets.AZURE_TENANT_ID }}

            # Set the active subscription
            az account set --subscription ${{ secrets.AZURE_SUBSCRIPTION_ID_STG }}

            # Get Slack token from Azure Key Vault
            SLACK_BOT_TOKEN=$(az keyvault secret show --name "exui-code-reviews-bot-slack-token" --vault-name "${{ secrets.AZURE_VAULT_NAME }}" --query "value" --output tsv)
            echo "::add-mask::$SLACK_BOT_TOKEN"
            echo "SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN" >> $GITHUB_ENV

            # Get token for data repo access from Azure Key Vault
            DATA_REPO_TOKEN=$(az keyvault secret show --name "${{ secrets.DATA_REPO_PAT_NAME }}" --vault-name "${{ secrets.AZURE_VAULT_NAME }}" --query "value" --output tsv)
            echo "::add-mask::$DATA_REPO_TOKEN"
            echo "DATA_REPO_TOKEN=$DATA_REPO_TOKEN" >> $GITHUB_ENV

      - name: Parse PR_BOT_CONFIG_JSON github variable into environment variables
        run: |
          echo "REQUIRED_APPROVALS=$(echo $PR_BOT_CONFIG_JSON | jq -r '.REQUIRED_APPROVALS')" >> $GITHUB_ENV
          echo "TITLE_MAX_LENGTH=$(echo $PR_BOT_CONFIG_JSON | jq -r '.TITLE_MAX_LENGTH')" >> $GITHUB_ENV
          echo "DATA_REPO_OWNER=$(echo $PR_BOT_CONFIG_JSON | jq -r '.DATA_REPO_OWNER')" >> $GITHUB_ENV
          echo "DATA_REPO_NAME=$(echo $PR_BOT_CONFIG_JSON | jq -r '.DATA_REPO_NAME')" >> $GITHUB_ENV
          echo "DATA_STATE_FILE_PATH=$(echo $PR_BOT_CONFIG_JSON | jq -r '.DATA_STATE_FILE_PATH')" >> $GITHUB_ENV
          echo "SLACK_CHANNEL=$(echo $PR_BOT_CONFIG_JSON | jq -r '.SLACK_CHANNEL')" >> $GITHUB_ENV
          echo "SLACK_CHANNEL_ID=$(echo $PR_BOT_CONFIG_JSON | jq -r '.SLACK_CHANNEL_ID')" >> $GITHUB_ENV
          echo "SKIP_CI_CHECK=$(echo $PR_BOT_CONFIG_JSON | jq -r '.SKIP_CI_CHECK')" >> $GITHUB_ENV
        env:
          PR_BOT_CONFIG_JSON: ${{ vars.PR_BOT_CONFIG_JSON }}

      - name: Run pr-bot
        run: |
          mkdir pr-bot-tmp
          cd pr-bot-tmp
          npx pr-bot
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SLACK_BOT_TOKEN: ${{ env.SLACK_BOT_TOKEN }}
          DATA_REPO_TOKEN: ${{ env.DATA_REPO_TOKEN }}
          REQUIRED_APPROVALS: ${{ env.REQUIRED_APPROVALS }}
          TITLE_MAX_LENGTH: ${{ env.TITLE_MAX_LENGTH }}
          DATA_REPO_OWNER: ${{ env.DATA_REPO_OWNER }}
          DATA_REPO_NAME: ${{ env.DATA_REPO_NAME }}
          DATA_STATE_FILE_PATH: ${{ env.DATA_STATE_FILE_PATH }}
          SLACK_CHANNEL: ${{ env.SLACK_CHANNEL }}
          SLACK_CHANNEL_ID: ${{ env.SLACK_CHANNEL_ID }}
          SKIP_CI_CHECK: ${{ env.SKIP_CI_CHECK }}
```

## Configuration

### GitHub Secrets

The following secrets must be configured in your GitHub repository:

#### Azure Authentication (for accessing Key Vault)
- `AZURE_CLIENT_ID` - Azure service principal client ID
- `AZURE_CLIENT_SECRET` - Azure service principal client secret  
- `AZURE_TENANT_ID` - Azure tenant ID
- `AZURE_SUBSCRIPTION_ID_STG` - Azure subscription ID
- `AZURE_VAULT_NAME` - Name of the Azure Key Vault containing bot tokens
- `DATA_REPO_PAT_NAME` - Name of the secret in Key Vault containing the data repo PAT

#### Required Secrets in Azure Key Vault
- `exui-code-reviews-bot-slack-token` - Slack bot token (stored in Key Vault)
- Personal access token with read/write permissions for data repo access (name specified by `DATA_REPO_PAT_NAME`)

The bot requires the following configuration variables:

#### Configuration Variables
- `REQUIRED_APPROVALS` - Number of required approvals for PRs
- `TITLE_MAX_LENGTH` - Maximum allowed length for PR titles
- `DATA_REPO_OWNER` - Owner of the data repository
- `DATA_REPO_NAME` - Name of the data repository
- `DATA_STATE_FILE_PATH` - Path to the state file in the data repository
- `SLACK_CHANNEL` - Slack channel name
- `SLACK_CHANNEL_ID` - Slack channel ID
- `SKIP_CI_CHECK` - Boolean, should be true if repository does not have the continuous-integration/jenkins/pr-head pipeline

### GitHub Variables

You should store configuration variables as a stringified JSON object in the repository variables:

```json
{"REQUIRED_APPROVALS":2,"TITLE_MAX_LENGTH":60,"DATA_REPO_OWNER":"owner","DATA_REPO_NAME":"name","DATA_STATE_FILE_PATH":"path/to/file.json","SLACK_CHANNEL":"channel","SLACK_CHANNEL_ID":"id"}
```

## License

MIT - See [LICENSE.md](LICENSE.md)

## Repository

[https://github.com/hmcts/rpx-xui-dev-utils/prBot](https://github.com/hmcts/rpx-xui-dev-utils/prBot)