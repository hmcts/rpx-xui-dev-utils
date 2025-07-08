#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

// branches not to reconstruct
const MAIN_BRANCHES = ['master', 'main', 'origin/master', 'origin/main'];

function run(cmd, cwd) {
    try {
        const output = execSync(cmd, { cwd, encoding: 'utf8' });
        return { success: true, output: output.trim() };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// formatted timestamp used for unique file naming
function getTimestamp() {
    return new Date().toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, -5);
}

function getBranchesToReconstruct(repoPath, mainBranch, daysThreshold = 30) {
    const allBranchList = run('git branch -all --format="%(refname:short)"', repoPath);
    
    if (!allBranchList.success) return {};

    const branches = {};
    
    const branchList = allBranchList.output.split('\n').filter(branch => branch && branch !== 'HEAD');

    for (const branch of branchList) {
        if (MAIN_BRANCHES.includes(branch)) continue;

        const lastCommitDetails = run(`git log -1 --format="%H|%an|%ae|%s|%ci" ${branch}`, repoPath);
        
        if (lastCommitDetails.success) {
            const [sha, author, email, message, commitDate] = lastCommitDetails.output.split('|');
            
            const lastCommitDate = new Date(commitDate);
            const daysSinceLastCommit = (Date.now() - lastCommitDate) / (1000 * 60 * 60 * 24);
            
            // skip old branches
            if (daysSinceLastCommit > daysThreshold) {
                console.log(`skipping old branch: ${branch} (${Math.floor(daysSinceLastCommit)} days old)`);
                continue;
            }

            // check if branch is merged into main
            const mergeCheck = run(
                `git merge-base --is-ancestor ${branch} ${mainBranch} 2>/dev/null`,
                repoPath
            );
            
            // if branch is merged, skip
            if (mergeCheck.success) {
                console.log(`skipping merged branch: ${branch}`);
                continue;
            }

            // check if branch has unique commits not in main
            const uniqueCommits = run(
                `git rev-list --count ${mainBranch}..${branch} 2>/dev/null`,
                repoPath
            );
            
            // skip if no unique commits
            if (uniqueCommits.success && uniqueCommits.output === '0') {
                console.log(`skipping branch with no unique commits: ${branch}`);
                continue;
            }

            // found active branch that needs reconstruction
            console.log(`branch needing reconstruction: ${branch}`);
            branches[branch] = { 
                sha, 
                author, 
                email, 
                message,
                lastCommitDate: commitDate,
                daysSinceLastCommit: Math.floor(daysSinceLastCommit)
            };
        }
    }

    return branches;
}


async function saveBranchesMetadata(branches, repo, config, timestamp, mainBranch, backupPath) {
    const metadataDir = path.resolve(config.metadata_dir || './metadata');
    
    await fs.mkdir(metadataDir, { recursive: true });
    
    const metadataFileName = path.join(metadataDir, `${repo.name}_${timestamp}.json`);

    const branchesMetadata = { 
        mainBranch,
        branches,
        repoPath: repo.path,
        backupPath,
        repoName: repo.name,
        timestamp
     };
    
    await fs.writeFile(metadataFileName, JSON.stringify(branchesMetadata, null, 2));
    
    return metadataFileName;
}

async function createRepoBackup(repo, config, timestamp) {
    const backupDir = path.resolve(config.backup_dir || './backups');
    
    await fs.mkdir(backupDir, { recursive: true });
    
    const backupPath = path.join(backupDir, `${repo.name}_${timestamp}`);
    
    run(`cp -r "${repo.path}" "${backupPath}"`);
    
    return backupPath;
}


function getSecretsFile(repo, config) {
    return path.resolve(repo.secrets_file || config.secrets_file);
}

async function cleanSecrets(repoPath, secretsFile, mainBranch) {
    const tempSecretsToRemovePath = path.join(repoPath, 'secrets-to-remove.txt');
    
    await fs.copyFile(secretsFile, tempSecretsToRemovePath);
    
    const result = run('git filter-repo --replace-text secrets-to-remove.txt', repoPath);
    
    await fs.unlink(tempSecretsToRemovePath);
    
    if (!result.success) {
        throw new Error(`git-filter-repo failed: ${result.error}`);
    }
    
    run(`git push --force origin ${mainBranch}`, repoPath);
}

async function cleanRepo(repo, config, dryRun) {
    console.log(`processing: ${repo.name}`);

    const runTimestamp = getTimestamp();

    console.log('finding active branches...');
    const mainBranch = repo.main_branch || config.main_branch;
    const daysThreshold = config.branch_age_days;
    const branches = getBranchesToReconstruct(repo.path, mainBranch, daysThreshold);
    console.log(`found ${Object.keys(branches).length} active branches to reconstruct`);

    const backupDir = path.resolve(config.backup_dir || './backups');
    const backupPath = path.join(backupDir, `${repo.name}_${runTimestamp}`);

    const metadataFile = await saveBranchesMetadata(branches, repo, config, runTimestamp, mainBranch, backupPath);

    if (dryRun) {
        console.log('DRY RUN MODE - stopping here otherwise would create backup and clean secrets');
        return true;
    }

    console.log('creating backup...');
    await createRepoBackup(repo, config, runTimestamp);

    const secretsFile = getSecretsFile(repo, config);
    
    try {
        await fs.access(secretsFile);
    } catch {
        console.error(`secrets file not found: ${secretsFile}`);
        return false;
    }

    console.log(`cleaning these secrets: ${secretsFile}`);
    
    try {
        await cleanSecrets(repo.path, secretsFile, mainBranch);
        console.log('done cleaning secrets');
        
        return true;
    } catch (error) {
        console.error(`failed: ${error.message}`);
        return false;
    }
}

async function reconstructBranchFromBackup(branchName, branchInfo, backupPath, cleanPath, mainBranch) {
    const cleanBranchName = branchName.replace('origin/', '');
    
    // run(`git checkout ${mainBranch}`, cleanPath);
    run (`git branch -D ${cleanBranchName} 2>/dev/null`, cleanPath);
    
    // const createBranch = run(`git checkout -b ${cleanBranchName}`, cleanPath);
    
    // if (!createBranch.success) {
    //     console.log('failed to create branch');
    //     return false;
    // }

    const mergeBase = run(
        `git merge-base ${mainBranch} ${branchInfo.sha}`,
        backupPath
    );
    
    if (!mergeBase.success) {
        console.log('could not find merge base where branch diverged');
        return false;
    }

    const mergeBaseCommitDetails = run(
        `git log -1 --format="%s%n%ae%n%at ${mergeBase.output}`,
        backupPath
    )
    
    if (!mergeBaseCommitDetails.success) {
        console.log('could not get merge base commit details');
        return false;
    }

    const [subject, email, timestamp] = mergeBaseCommitDetails.output.split('\n');

    const findEquivalentCommit = run(
        `git log -all --format="%H %s %ae %at | grep -F "${subject} ${email} ${timestamp}" | head -1 | cut -d' ' -f1`,
        cleanPath
    );

    if (!findEquivalentCommit.success || !findEquivalentCommit.output) {
        console.log('could not find equivalent commit in clean repo');
        console.log('failing back to main branch');
        run (`git checkout ${mainBranch}`, cleanPath);
    } else {
        console.log(`branching from equivalent commit: ${findEquivalentCommit.output.sunstring(0, 8)}`);
        run(`git checkout ${findEquivalentCommit.output}`, cleanPath);
    }

    const createBranch = run(`git checkout -b ${cleanBranchName}`, cleanPath);

    if (!createBranch.success) {
        console.log('failed to create branch');
        return false;
    }

    const shasOfCommitsBetweenMergeBaseAndTip = run(`git log --format="%H" ${mergeBase.output}..${branchInfo.sha}`, backupPath);
    
    if (!shasOfCommitsBetweenMergeBaseAndTip.success) {
        console.log('could not get commits');
        return false;
    }

    // need in chronological order
    const shas = shasOfCommitsBetweenMergeBaseAndTip.output.split('\n').filter(sha => sha).reverse();
    console.log(`${shas.length} commits to cherry-pick`);
    
    for (const sha of shas) {
        const cherryPick = run(`git cherry-pick ${sha}`, cleanPath);
        if (!cherryPick.success) {
            run('git cherry-pick --abort 2>/dev/null', cleanPath);
        }
    }

    const pushResult = run(`git push --force origin ${cleanBranchName}`, cleanPath);

    if (!pushResult.success) {
        console.log(`failed to push branch ${cleanBranchName}`);
        return false;
    }

    console.log(`reconstructed branch ${cleanBranchName} from backup`);
    return true;
}

async function getLatestMetadataForRepo(repoName, metadataDir) {
    try {
        const files = await fs.readdir(metadataDir);
        
        const repoFiles = files
            .filter(file => file.startsWith(repoName) && file.endsWith('.json'))
            .sort();

        return repoFiles.length > 0 ? path.join(metadataDir, repoFiles[repoFiles.length - 1]) : null;
    } catch (error) {
        console.error(`error reading metadata directory: ${error.message}`);
        return null;
    }
}

async function reconstructSingleRepoBranches(metadataFile) {
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));

    const mainBranch = metadata.mainBranch,
        branches = metadata.branches,
        backupPath = metadata.backupPath,
        cleanPath = metadata.repoPath; 
    
    const featureBranches = Object.entries(branches)
        .filter(([name]) => !MAIN_BRANCHES.includes(name));

    console.log(`${featureBranches.length} branches to reconstruct`);

    if (featureBranches.length === 0) {
        console.log('no branches to reconstruct');
        return;
    }

    // add backup as a git remote so we can access its commits
    run('git remote remove backup 2>/dev/null', cleanPath);
    run(`git remote add backup "${backupPath}"`, cleanPath);
    run('git fetch backup', cleanPath);

    let successCount = 0;
    for (const [branchName, branchInfo] of featureBranches) {
        if (await reconstructBranchFromBackup(branchName, branchInfo, backupPath, cleanPath, mainBranch)) {
            successCount++;
        }
    }

    // cleanup
    run('git remote remove backup', cleanPath);
    run(`git checkout ${mainBranch}`, cleanPath);

    console.log(`reconstructed ${successCount}/${featureBranches.length} branches`);
}

async function reconstructAllReposBranches(configFile) {
    console.log('reconstructing branches for all repositories\n');
    
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    const metadataDir = path.resolve(config.metadata_dir || './metadata');
    
    for (const repo of config.repositories) {
        console.log(`processing: ${repo.name}`);
        
        const metadataFile = await getLatestMetadataForRepo(repo.name, metadataDir);
        
        if (!metadataFile) {
            console.log(`no metadata found for ${repo.name}. skipping...`);
            continue;
        }
        
        console.log(`using metadata: ${path.basename(metadataFile)}`);
        
        try {
            await reconstructSingleRepoBranches(metadataFile);
        } catch (error) {
            console.error(`failed to reconstruct ${repo.name}: ${error.message}`);
        }
    }
    
    console.log('reconstruction finsihed');
}

function parseArgs() {
    const args = process.argv.slice(2);
    
    const configFile = './config.json';
    
    return {
        configFile,
        mode: args.includes('--reconstruct') ? 'reconstruct' : 'clean',
        dryRun: args.includes('--dry-run')
    };
}

async function main() {
    const options = parseArgs();
    
    if (options.mode === 'reconstruct') {
        await reconstructAllReposBranches(options.configFile);
        return;
    }
    
    if (!run('git filter-repo --version').success) {
        console.error('need to install git-filter-repo');
        process.exit(1);
    }
    
    const config = JSON.parse(await fs.readFile(options.configFile, 'utf8'));
    
    console.log('secret cleanup starting...');
    console.log(`mode: ${options.dryRun ? 'dry-run' : 'live'}`);
    
    for (const repo of config.repositories) {
        try {
            await cleanRepo(repo, config, options.dryRun);
        } catch (error) {
            console.error(`error processing ${repo.name}: ${error.message}`);
        }
    }
    
    console.log('completed secret cleanup');
    console.log('to reconstruct branches for all repos run:');
    console.log('./secret-cleanup.js --reconstruct');
}

main().catch(console.error);