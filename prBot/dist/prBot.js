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
  dataStateFilePath: process.env.DATA_STATE_FILE_PATH
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
    console.log('GitHub event data loaded:', data);
    
    // Log all PR labels
    if (data.pull_request?.labels && data.pull_request.labels.length > 0) {
      console.log('GitHub PR labels:');
      data.pull_request.labels.forEach((label, index) => {
        console.log(`Label ${index}: `, label);
      });
    } else {
      console.log('No labels found on this PR');
    }
    
    console.log('[DEBUG CHANGES REQUESTED] data.review?.state: ', data.review?.state);
    return {
      action: data.action,
      prNumber: data.pull_request?.number,
      prAuthor: data.pull_request?.user?.login,
      prTitle: data.pull_request?.title,
      repo: data.repository?.full_name,
      reviewState: data.review?.state || ''
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
        resolve(data ? JSON.parse(data || '{}') : {});
      });
    });
    
    req.on('error', error => reject(error));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const github = {
  async getReviews(repo, prNumber) {
    const path = `/repos/${repo}/pulls/${prNumber}/reviews`;
    const headers = {
      'Authorization': `Bearer ${ENV.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    };
    
    const reviews = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', headers),
      approvedCount = reviews.filter(review => review.state === 'APPROVED').length,
      changesRequestedCount = reviews.filter(review => review.state === 'CHANGES_REQUESTED').length;

    return { approvedCount, changesRequestedCount };
  }
};

const slack = {
  async postMessage(channel, text) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
    
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.postMessage',
      'POST',
      headers,
      { channel, text }
    );
        
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
    
    return response.ts;
  },

  async updateMessage(channel, ts, text) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };
    
    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.update',
      'POST',
      headers,
      { channel, ts, text }
    );
    
    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  },

  async deleteMessage(channel, ts) {
    const headers = {
      'Authorization': `Bearer ${ENV.slackBotToken}`,
      'Content-Type': 'application/json'
    };

    const response = await httpRequest(
      CONFIG.SLACK_API_BASE,
      '/api/chat.delete',
      'POST',
      headers,
      { channel, ts }
    );

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.error}`);
    }
  }
};

const stateManager = {
  async readState() {
    try {
      const path = `/repos/${ENV.dataRepoOwner}/${ENV.dataRepoName}/contents/${ENV.dataStateFilePath}`;
      const headers = {
        'Authorization': `Bearer ${ENV.dataRepoToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node.js'
      }

      const response = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'GET', headers);

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
    const headers = {
      'Authorization': `Bearer ${ENV.dataRepoToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node.js'
    }

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

      const stateAfter = await httpRequest(CONFIG.GITHUB_API_BASE, path, 'PUT', headers, body);
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

  async updatePR(repo, prNumber, updates, maxRetires = 3) {
    for (let attempt = 0; attempt < maxRetires; attempt++) {
      try {
        const { state, sha } = await this.readState();
        console.log('Updating PR state before:', state);

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
        if (error.message === 'CONFLICT' && attempt < maxRetires) {
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
        if (error.message === 'CONFLICT' && attempt < maxRetires) {
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

  async updateMetadata(updates, maxRetires = 3) {
    for (let attempt = 0; attempt < maxRetires; attempt++) {
      try {
        const { state, sha } = await this.readState();
        state.metadata = {
          ...state.metadata,
          ...updates
        };
        await this.writeState(state, sha);
        return;
      } catch (error) {
        if (error.message === 'CONFLICT' && attempt < maxRetires) {
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

  console.log('Reposting approval list with state:', state);

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

  console.log('Needs approval PRs after sorting:', needsApproval);

  let message = '';

  needsApproval.forEach(pr => {
    const emoji = pr.changesRequested ? '🔧 ' : '';
    message += formatPRMessage(pr.number, pr.author, pr.title, pr.repository, pr.approvals, emoji) + '\n\n';
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

  if (needsApproval.length > 0) {
    console.log('Posting approval list message:', message);
  
    const ts = await slack.postMessage(ENV.slackChannelId, message);
    await stateManager.updateMetadata({ approvalListMessageTs: ts });
  }
}

function formatPRMessage(prNumber, prAuthor, prTitle, repo, approvedCount, emoji = '') {
  const truncatedTitle = prTitle.length > ENV.titleMaxLength 
    ? prTitle.slice(0, ENV.titleMaxLength) + '…' 
    : prTitle;
  const prLink = `https://github.com/${repo}/pull/${prNumber}`;
  
  return `(${approvedCount} of ${ENV.requiredApprovals} approvals) PR #${prNumber} by ${prAuthor}:\n${emoji}<${prLink}|${truncatedTitle}>`;
}

async function handlePROpened(event) {
  const { prNumber, prAuthor, prTitle, repo } = event;
  const { approvedCount, changesRequestedCount } = await github.getReviews(repo, prNumber);

  await stateManager.updatePR(repo, prNumber, {
    number: prNumber,
    title: prTitle,
    author: prAuthor,
    url: `https://github.com/${repo}/pull/${prNumber}`,
    changesRequested: changesRequestedCount > 0,
    approvals: approvedCount,
    createdAt: new Date().toISOString(),
  })

  await repostApprovalList();
}

async function handlePRReview(event) {
  const { prNumber, prAuthor, prTitle, repo, reviewState } = event;

  if (reviewState === 'changes_requested') {
    await handlePRChangesRequested(event);
    return;
  }

  await sleep(2000);

  const { approvedCount, changesRequestedCount } = await github.getReviews(repo, prNumber);

  if ((approvedCount >= ENV.requiredApprovals) && changesRequestedCount === 0) {
    // post standalone approval message
    const message = formatPRMessage(prNumber, prAuthor, prTitle, repo, approvedCount, '✅✅ ');
    await slack.postMessage(ENV.slackChannelId, message);

    // remove from state
    await stateManager.removePR(repo, prNumber)
  } else {
    await stateManager.updatePR(repo, prNumber, {
      number: prNumber,
      title: prTitle,
      author: prAuthor,
      url: `https://github.com/${repo}/pull/${prNumber}`,
      changesRequested: changesRequestedCount > 0,
      approvals: approvedCount,
      createdAt: new Date().toISOString()
    });
  }

  await repostApprovalList();
}

async function handlePRChangesRequested(event) {
  const { prNumber, prAuthor, repo, prTitle, reviewState } = event;

  const { approvedCount } = await github.getReviews(repo, prNumber);

  if (reviewState !== 'changes_requested') {
    return;
  }

  await stateManager.updatePR(repo, prNumber, {
    number: prNumber,
    title: prTitle,
    author: prAuthor,
    url: `https://github.com/${repo}/pull/${prNumber}`,
    changesRequested: true,
    approvals: approvedCount,
    createdAt: new Date().toISOString(),
  });

  await repostApprovalList();
}

async function handlePRClosed(event) {
  const { prNumber, repo } = event;

  await stateManager.removePR(repo, prNumber);

  await repostApprovalList();
}

async function run() {
  validateEnvironment();
  const event = loadEventData();
  
  if (!event.prNumber || !event.repo) {
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
  formatPRMessage,
  handlePROpened,
  handlePRReview,
  handlePRChangesRequested,
  handlePRClosed,
  run
}

if (require.main === module) {
  run();
}