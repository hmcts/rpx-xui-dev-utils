#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

const CONFIG = {
  SLACK_API_BASE: 'slack.com',
  GITHUB_API_BASE: 'api.github.com',
};

const ENV = {
  requiredApprovals: process.env.REQUIRED_APPROVALS,
  titleMaxLength: process.env.TITLE_MAX_LENGTH,
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackChannel: process.env.SLACK_CHANNEL,
  slackChannelId: process.env.SLACK_CHANNEL_ID,
  githubToken: process.env.GITHUB_TOKEN,
  githubEventPath: process.env.GITHUB_EVENT_PATH,
  dataRepoToken: process.env.DATA_REPO_TOKEN,
  dataRepoOwner: process.env.DATA_REPO_OWNER,
  dataRepoName: process.env.DATA_REPO_NAME,
  dataStateFilePath: process.env.DATA_STATE_FILE_PATH,
  skipCICheck: process.env.SKIP_CI_CHECK === 'true'
};

function validateEnvironment() {
  const required = [
    'requiredApprovals',
    'titleMaxLength',
    'slackBotToken',
    'slackChannel',
    'slackChannelId',
    'githubToken',
    'githubEventPath',
    'dataRepoToken',
    'dataRepoOwner',
    'dataRepoName',
    'dataStateFilePath'
  ];
  const missing = required.filter(key => !ENV[key]);
  
  if (missing.length > 0) {
    console.error(`Missing required env variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadEventData() {
  try {
    const data = JSON.parse(fs.readFileSync(ENV.githubEventPath, 'utf8'));

    if (data.context === 'continuous-integration/jenkins/pr-head') {
      return {
        eventType: 'status',
        state: data.state,
        sha: data.sha,
        branches: data.branches,
        repo: data.repository?.full_name,
      };
    }

    return {
      action: data.action,
      eventType: 'pull_request',
      prNumber: data.pull_request?.number,
      prAuthor: data.pull_request?.user?.login,
      prTitle: data.pull_request?.title,
      repo: data.repository?.full_name,
      reviewState: data.review?.state || '',
      label: data.label?.name,
      labels: data.pull_request?.labels,
      headSha: data.pull_request?.head?.sha
    };
  } catch (error) {
    console.error('Failed to parse GitHub event:', error.message);
    process.exit(1);
  }
}

async function httpRequest(hostname, path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method, headers };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = data ? JSON.parse(data || '{}') : {};
        result._linkHeader = res.headers.link;
        resolve(result);
      });
    });
    
    req.on('error', error => reject(error));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const github = {
  getHeaders() {
    return {
      'Authorization': `Bearer ${ENV.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
  },

  async getReviews(repo, prNumber) {
    const path = `/repos/${repo}/pulls/${prNumber}/reviews`;
    const reviews = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', this.getHeaders());

    // get the latest review from each unique reviewer
    const latestReviewsMap = new Map();

    reviews.forEach(review => {
      const userId = review.user.id;
      const existingReview = latestReviewsMap.get(userId);

      if (!existingReview || new Date(review.submitted_at) > new Date(existingReview.submitted_at)) {
        latestReviewsMap.set(userId, review);
      }
    });

    const latestReviews = Array.from(latestReviewsMap.values());

    const approvedCount = latestReviews.filter(review => review.state === 'APPROVED').length;
    const changesRequestedCount = latestReviews.filter(review => review.state === 'CHANGES_REQUESTED').length;

    return { approvedCount, changesRequestedCount };
  },

  async getPR(repo, prNumber) {
    const path = `/repos/${repo}/pulls/${prNumber}`;
    const pr = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', this.getHeaders());
    return pr;
  },

  async getCommitStatus(repo, sha) {
    const path = `/repos/${repo}/commits/${sha}/status`;
    const response = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', this.getHeaders());
    return response;
  },

  async getCommitPRs(repo, sha) {
    const path = `/repos/${repo}/commits/${sha}/pulls`;
    const prs = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', this.getHeaders());
    return prs;
  }
};

const slack = {
  getHeaders() {
    return {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
  },

  async postMessage(channel, text) {
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.postMessage',
      'POST',
      this.getHeaders(),
      { channel, text }
    );
        
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
    return response.ts;
  },

  async updateMessage(channel, ts, text) {
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.update',
      'POST',
      this.getHeaders(),
      { channel, ts, text }
    );
    
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  },

  async deleteMessage(channel, ts) {
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.delete',
      'POST',
      this.getHeaders(),
      { channel, ts }
    );

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  }
};

const stateManager = {
  getHeaders() {
    return {
      'Authorization': `Bearer ${ENV.dataRepoToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
  },

  async readState() {
    try {
      const path = `/repos/${ENV.dataRepoOwner}/${ENV.dataRepoName}/contents/${ENV.dataStateFilePath}`;
      const response = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', this.getHeaders());

      if (response.content) {
        const content = Buffer.from(response.content, 'base64').toString();
        return {
          state: JSON.parse(content),
          sha: response.sha
        };
      } else {
        console.log('No state file found');
      }
    } catch (error) {
      throw new Error(`Failed to read state: ${error.message}`);
    }
  },
  
  async writeState(state, sha) {
    const path = `/repos/${ENV.dataRepoOwner}/${ENV.dataRepoName}/contents/${ENV.dataStateFilePath}`;

    try {
      const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
      const body = {
        message: `Update PR state from ${loadEventData().repo}`,
        content,
        branch: 'master'
      }

      if (sha) {
        body.sha = sha;
      }

      const stateAfter = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'PUT', this.getHeaders(), body);
      console.log('State written successfully');
      await sleep(2000);
      return stateAfter;
    } catch (error) {
      if (error.message?.includes('409')) {
        console.error('Conflict error while writing state, retrying...');
        throw new Error('CONFLICT');        
      }

      throw new Error(`Failed to write state: ${error.message}`);
    }
  },

  async updatePR(repo, prNumber, updates, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { state, sha } = await this.readState();

        if (!state.repositories[repo]) {
          state.repositories[repo] = { pullRequests: {} };
        }

        state.repositories[repo].pullRequests[prNumber] = {
          ...state.repositories[repo].pullRequests[prNumber],
          ...updates,
          lastUpdated: new Date().toISOString()
        };

        state.metadata.lastUpdated = new Date().toISOString();

        await this.writeState(state, sha);
        return state;
      } catch (error) {
        if (error.message === 'CONFLICT' && attempt < maxRetries) {
          console.log(`Retrying update PR state due to conflict (attempt ${attempt + 1})...`);
          await sleep(1000 * (attempt + 1));
          // re-read state and reapply updates
          continue;
        } else {
          console.error(`Failed to update PR state: ${error.message}`);
          throw error;
        }
      }
    }
  },

  async removePR(repo, prNumber, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { state, sha } = await this.readState();

        if (state.repositories[repo]?.pullRequests[prNumber]) {
          delete state.repositories[repo].pullRequests[prNumber];

          if (Object.keys(state.repositories[repo].pullRequests).length === 0) {
            delete state.repositories[repo];
          }

          state.metadata.lastUpdated = new Date().toISOString();
          await this.writeState(state, sha);
        }
        return;
      } catch (error) {
        if (error.message === 'CONFLICT' && attempt < maxRetries) {
          console.log(`Retrying remove PR state due to conflict (attempt ${attempt + 1})...`);
          await sleep(1000 * (attempt + 1));
          // re-read state and reapply updates
          continue;
        } else {
          console.error(`Failed to remove PR state: ${error.message}`);
          throw error;
        }
      }
    }
  },

  async updateMetadata(updates, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const { state, sha } = await this.readState();
        state.metadata = {
          ...state.metadata,
          ...updates
        };
        await this.writeState(state, sha);
        return;
      } catch (error) {
        if (error.message === 'CONFLICT' && attempt < maxRetries) {
          console.log(`Retrying update metadata due to conflict (attempt ${attempt + 1})...`);
          await sleep(1000 * (attempt + 1));
          continue;
        } else {
          console.error(`Failed to update metadata: ${error.message}`);
          throw error;
        }
      }
    }
  }
}

async function repostApprovalList() {
  await sleep(3000);

  const { state } = await stateManager.readState();
  const needsApproval = [];
  
  Object.entries(state.repositories).forEach(([repo, data]) => {
    Object.values(data.pullRequests).forEach(pr => {
      needsApproval.push({
        ...pr,
        repository: repo
      });
    });
  });

  needsApproval.sort((a, b) => {
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  let message = '';

  // only include PRs with green builds
  needsApproval.forEach(pr => {
    if (pr.buildSuccess) {
      const emoji = pr.changesRequested ? '🔧 ' : '';
      message += formatPRMessage(pr.number, pr.author, pr.title, pr.repository, pr.approvals, emoji) + '\n\n';
    }
  });

  // delete previous approval list message if it exists to maintain single message at head position
  if (state.metadata.approvalListMessageTs) {
    try {
      await slack.deleteMessage(ENV.slackChannelId, state.metadata.approvalListMessageTs);
      await stateManager.updateMetadata({ approvalListMessageTs: null });
    } catch (error) {
      // if message doesn't exist, we can ignore the error
    }
  }

  if (message.length > 0) {  
    const ts = await slack.postMessage(ENV.slackChannelId, message);
    await stateManager.updateMetadata({ approvalListMessageTs: ts });
  }
}

async function getBuildStatus(repo, sha, labels) {
  const skipBuild = labels?.some(label => label.name === 'prbot-skip-ci');

  if (skipBuild || ENV.skipCICheck) {
    return true;
  }

  try {
    const commitStatus = await github.getCommitStatus(repo, sha);
    console.log(`Commit status for ${repo}@${sha}: `, commitStatus);
    return commitStatus?.state === 'success';
  } catch (error) {
    console.error(`Failed to get build status: ${error.message}`);
  }

  return false;
}

function formatPRMessage(prNumber, prAuthor, prTitle, repo, approvedCount, emoji = '') {
  const truncatedTitle = prTitle.length > ENV.titleMaxLength ? prTitle.slice(0, ENV.titleMaxLength) + '…' : prTitle;
  const prLink = `https://github.com/${repo}/pull/${prNumber}`;
  const repoName = repo.split('/')[1];

  return `(${approvedCount} of ${ENV.requiredApprovals} approvals) ${repoName} PR #${prNumber} by ${prAuthor}:\n${emoji}<${prLink}|${truncatedTitle}>`;
}

async function createPRStateUpdate(repo, prNumber, prTitle, prAuthor, approvedCount, changesRequestedCount, pr) {
  const buildSuccess = await getBuildStatus(repo, pr.head.sha, pr.labels);

  return {
    number: prNumber,
    title: prTitle,
    author: prAuthor,
    url: `https://github.com/${repo}/pull/${prNumber}`,
    changesRequested: changesRequestedCount > 0,
    approvals: approvedCount,
    buildSuccess,
    headSha: pr.head.sha,
    createdAt: new Date().toISOString(),
  };
}

async function fetchPRDataAndCreateState(repo, prNumber, prTitle, prAuthor) {
  const { approvedCount, changesRequestedCount } = await github.getReviews(repo, prNumber);
  const pr = await github.getPR(repo, prNumber);
  const prState = await createPRStateUpdate(repo, prNumber, prTitle, prAuthor, approvedCount, changesRequestedCount, pr);
  return prState;
}

async function handlePROpened(event) {
  const { prNumber, prAuthor, prTitle, repo, labels } = event;

  if (labels?.some(label => label.name === 'prbot-ignore')) {
    console.log('ignoring PR, prbot-ignore label is present');
    return;
  }

  const prState = await fetchPRDataAndCreateState(repo, prNumber, prTitle, prAuthor);
  await stateManager.updatePR(repo, prNumber, prState);

  if (prState.buildSuccess) {
    await repostApprovalList();
  } else {
    console.log('build status is not success, delaying slack notification');
  }
}

async function handlePRReview(event) {
  const { prNumber, prAuthor, prTitle, repo, reviewState, labels } = event;

  if (reviewState === 'changes_requested') {
    await handlePRChangesRequested(event);
    return;
  }

  if (labels?.some(label => label.name === 'prbot-ignore')) {
    console.log('ignoring PR, prbot-ignore label is present');
    return;
  }

  await sleep(2000);

  const { approvedCount, changesRequestedCount } = await github.getReviews(repo, prNumber);

  if ((approvedCount >= ENV.requiredApprovals) && changesRequestedCount === 0) {
    // post standalone approval message regardless of build status
    const message = formatPRMessage(prNumber, prAuthor, prTitle, repo, approvedCount, '✅✅ ');
    await slack.postMessage(ENV.slackChannelId, message);
    await stateManager.removePR(repo, prNumber);
  } else {
    const pr = await github.getPR(repo, prNumber);
    const prState = await createPRStateUpdate(repo, prNumber, prTitle, prAuthor, approvedCount, changesRequestedCount, pr);
    await stateManager.updatePR(repo, prNumber, prState);
  }

  await repostApprovalList();
}

async function handlePRChangesRequested(event) {
  const { prNumber, prAuthor, repo, prTitle, reviewState } = event;

  if (reviewState !== 'changes_requested') {
    return;
  }

  if (labels?.some(label => label.name === 'prbot-ignore')) {
    console.log('ignoring PR, prbot-ignore label is present');
    return;
  }

  const { approvedCount } = await github.getReviews(repo, prNumber);
  const pr = await github.getPR(repo, prNumber);
  const prState = await createPRStateUpdate(repo, prNumber, prTitle, prAuthor, approvedCount, 1, pr);

  await stateManager.updatePR(repo, prNumber, prState);
  await repostApprovalList();
}

async function handlePRClosed(event) {
  const { prNumber, repo } = event;

  await stateManager.removePR(repo, prNumber);
  await repostApprovalList();
}

async function handlePRLabeled(event) {
  const { prNumber, repo, label, prAuthor, prTitle } = event;

  if (label !== 'prbot-ignore' && label !== 'prbot-skip-ci') {
    console.log('Ignoring event, label is not prbot-ignore or prbot-skip-ci');
    return;
  }

  const { state } = await stateManager.readState();

  if (label === 'prbot-ignore') {  
    if (state.repositories[repo]?.pullRequests[prNumber]) {
      await stateManager.removePR(repo, prNumber);
      await repostApprovalList();
    } else {
      console.log('PR not found in state, ignoring event');
    }
  } else if (label === 'prbot-skip-ci') {
    if (state.repositories[repo]?.pullRequests[prNumber]) {
      const prState = await fetchPRDataAndCreateState(repo, prNumber, prTitle, prAuthor);
      await stateManager.updatePR(repo, prNumber, prState);
      await repostApprovalList();
    } else {
      console.log('PR not found in state, ignoring event');
    }
  }
}

async function handlePRUnlabeled(event) {
  const { prNumber, repo, label, prAuthor, prTitle } = event;

  if (label !== 'prbot-ignore' && label !== 'prbot-skip-ci') {
    console.log('Ignoring event, label is not prbot-ignore or prbot-skip-ci');
    return;
  }

  const { state } = await stateManager.readState();

  if (label === 'prbot-ignore') {
    if (!state.repositories[repo]?.pullRequests[prNumber]) {
      const prState = await fetchPRDataAndCreateState(repo, prNumber, prTitle, prAuthor);
      await stateManager.updatePR(repo, prNumber, prState);
      await repostApprovalList();
    } else {
      console.log('PR already exists in state, ignoring event');
    }
  } else if (label === 'prbot-skip-ci') {
    // prbot-skip-ci removed, re-evaluate build status
    if (state.repositories[repo]?.pullRequests[prNumber]) {
      const prState = await fetchPRDataAndCreateState(repo, prNumber, prTitle, prAuthor);
      await stateManager.updatePR(repo, prNumber, prState);
      await repostApprovalList();
    } else {
      console.log('PR not found in state, ignoring event');
    }
  }
}

async function handleStatus(event) {
  const { state, sha, repo } = event;

  const prs = await github.getCommitPRs(repo, sha);

  if (!prs || prs.length === 0) {
    console.log('No PRs associated with this commit, ignoring event');
    return;
  }

  const { state: prState } = await stateManager.readState();

  let needsRepost = false;

  for (const pr of prs) {
    const prNumber = pr.number;
    const trackedPR = prState.repositories[repo]?.pullRequests[prNumber];

    if (!trackedPR) {
      console.log(`PR #${prNumber} not found in state, skipping`);
      continue;
    }

    const skipBuild = pr.labels?.some(label => label.name === 'prbot-skip-ci');

    if (skipBuild || ENV.skipCICheck) {
      console.log(`PR #${prNumber} has prbot-skip-ci label, skipping build status update`);
      continue;
    }

    const newBuildSuccess = state === 'success';
    const oldBuildSuccess = trackedPR.buildSuccess;

    console.log(`PR #${prNumber} build status from: ${oldBuildSuccess} to ${newBuildSuccess}`);

    if (newBuildSuccess !== oldBuildSuccess) {
      await stateManager.updatePR(repo, prNumber, {
        ...trackedPR,
        buildSuccess: newBuildSuccess,
        headSha: sha,
        lastUpdated: new Date().toISOString()
      });

      needsRepost = true;
    }
  }

  if (needsRepost) {
    await repostApprovalList();
  }
}

async function run() {
  validateEnvironment();
  const event = loadEventData();

  if (!event.repo) {
    console.error('Error with repo data');
    return;
  }

  if (event.eventType === 'status') {
    try {
      await handleStatus(event);
    } catch (error) {
      console.error(`Error processing status event:`, error.message);
      process.exit(1);
    }
  }

  if (!event.prNumber) {
    console.error('Error with PR data');
    return;
  }

  try {
    switch (event.action) {
      case 'opened':
      case 'reopened':
        await handlePROpened(event);
        break;
      case 'submitted':
        await handlePRReview(event);
        break;
      case 'closed':
        await handlePRClosed(event);
        break;
      case 'labeled':
        await handlePRLabeled(event);
        break;
      case 'unlabeled':
        await handlePRUnlabeled(event);
        break;
      default:
        console.log(`No workflow required for event: ${event.action}`);
    }
  } catch (error) {
    console.error(`Error processing ${event.action} event:`, error.message);
    process.exit(1);
  }
}

module.exports = {
  CONFIG,
  ENV,
  validateEnvironment,
  sleep,
  loadEventData,
  httpRequest,
  github,
  slack,
  stateManager,
  repostApprovalList,
  getBuildStatus,
  formatPRMessage,
  createPRStateUpdate,
  fetchPRDataAndCreateState,
  handlePROpened,
  handlePRReview,
  handlePRChangesRequested,
  handlePRClosed,
  handlePRLabeled,
  handlePRUnlabeled,
  handleStatus,
  run
}

if (require.main === module) {
  run();
}