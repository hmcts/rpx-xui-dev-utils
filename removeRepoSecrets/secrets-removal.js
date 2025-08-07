#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

function run(cmd, cwd) {
    try {
        const output = execSync(cmd, { cwd, encoding: 'utf8' });
        return { success: true, output: output.trim() };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function parseMode() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'analysis';
    const validModes = ['analysis', 'update', 'update-and-push'];

    if (validModes.includes(mode)) {
        return mode;
    } else {
        console.error(`Error: Invalid mode: '${mode}' - use 'analysis' (default), 'update', or 'update-and-push'`);
        process.exit(1);
    }
}

function confirmAction(message) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(`${message} Type YES to confirm: `, (answer) => {
            rl.close();
            resolve(answer === 'YES');
        });
    });
}

// formatted timestamp used for unique file naming
function getTimestamp() {
    return new Date().toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, -5);
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

async function cleanSecretsLocally(repoPath, secretsFile) {
    const tempSecretsToRemovePath = path.join(repoPath, 'secrets-to-remove.txt');
    
    await fs.copyFile(secretsFile, tempSecretsToRemovePath);
    
    const result = run('git filter-repo --sensitive-data-removal --replace-text secrets-to-remove.txt --force', repoPath);
    
    await fs.unlink(tempSecretsToRemovePath);
    
    if (!result.success) {
        throw new Error(`git-filter-repo failed: ${result.error}`);
    }
}

function ensureOriginRemote(repoPath, repoUrl) {
    const remoteCheck = run('git remote -v', repoPath);
    if (!remoteCheck.success || !remoteCheck.output.includes('origin')) {
        const remoteAdded = run(`git remote add origin ${repoUrl}`, repoPath);
        if (!remoteAdded.success) {
            // if the error is because the remote already exists, ignore it
            if (remoteAdded.error.includes('remote origin already exists')) {
                return;
            }
            throw new Error(`Failed to add origin remote: ${remoteAdded.error}`);
        }
    }
}

async function showPushToRemoteMessage(repoPath, repoUrl) {
    ensureOriginRemote(repoPath, repoUrl);
    const pushCommand = 'git push --force --mirror origin';
    console.log(`\nTo check if a specific secret is still present on your local, run:\n cd ${repoPath} && git log -G "<SECRET_STRING>" --all --oneline`);
    console.log(`\nOr to push your changes to the remote repository, run:\n cd ${repoPath} && ${pushCommand}\n`);
    return pushCommand;
}

async function pushToRemote(repoPath, repoUrl) {
    ensureOriginRemote(repoPath, repoUrl);
    run('git push --force --mirror origin', repoPath);
}

async function analyseRepo(repoPath, secretsFile, config) {
    const tempSecretsToRemovePath = path.join(repoPath, 'secrets-to-remove.txt');
    
    await fs.copyFile(secretsFile, tempSecretsToRemovePath);
    
    console.log('\nAnalysing repository...\n');
    
    const timestamp = getTimestamp();
    const tempRepoPath = path.join(process.cwd(), `temp-analysis-${timestamp}`);
    
    const analysisDir = path.resolve(config.analysis_dir || './analysis');
    await fs.mkdir(analysisDir, { recursive: true });
    
    try {
        run(`cp -r "${repoPath}" "${tempRepoPath}"`);
        
        await fs.mkdir(tempRepoPath, { recursive: true });
        await fs.copyFile(secretsFile, path.join(tempRepoPath, 'secrets-to-remove.txt'));
        
        const filterResult = run('git filter-repo --sensitive-data-removal --replace-text secrets-to-remove.txt --force', tempRepoPath);
        
        if (!filterResult.success) {
            throw new Error(`git-filter-repo failed: ${filterResult.error}`);
        }
        
        const diffResult = run(`git diff --no-index --no-prefix "${repoPath}" "${tempRepoPath}" || true`, process.cwd());
        
        if (diffResult.output) {
            const repoName = path.basename(repoPath);
            const diffPath = path.join(analysisDir, `${repoName}-analysis-${timestamp}.diff`);
            await fs.writeFile(diffPath, diffResult.output);
            console.log(`Analysis diff saved to:\n  ${diffPath}`);

            run(`npx diff2html-cli -i file -o preview -- "${diffPath}"`, process.cwd());
        } else {
            console.log('No changes detected in the repository.');
        }
        
        await fs.rm(tempRepoPath, { recursive: true, force: true });
        
    } catch (error) {
        try {
            await fs.rm(tempRepoPath, { recursive: true, force: true });
        } catch (cleanupError) {
            console.warn(`Warning: Failed to clean up temp directory: ${cleanupError.message}`);
        }
        throw error;
    } finally {
        await fs.unlink(tempSecretsToRemovePath);
    }
}

async function cleanRepo(repo, config, mode) {
    console.log(`Processing: ${repo.name}`);
    
    const secretsFile = getSecretsFile(repo, config);

    const runTimestamp = getTimestamp();

    try {
        if (mode === 'analysis') {
            // no backup or changes locally
            // secrets are removed from a temporary copied repo which gets deleted after
            await analyseRepo(repo.path, secretsFile, config)
        } else if (mode === 'update') {
            // backup and update locally only
            console.log('Creating backup...');
            const backupPath = await createRepoBackup(repo, config, runTimestamp);
            console.log(`Backup successfully created:\n  ${backupPath}`);
            console.log('\nIMPORTANT:');
            console.log(`This process will rewrite your LOCAL GIT HISTORY to permanently remove the secrets listed in:\n  ${secretsFile}`);
            console.log('\n\nAre you sure you want to rewrite your local history?');

            const confirmed = await confirmAction('\n\n ');

            if (confirmed) {
                console.log('\nUpdating local repository...');
                await cleanSecretsLocally(repo.path, secretsFile);
                console.log('Local repository updated successfully.');
                await showPushToRemoteMessage(repo.path, repo.url);
            } else {
                console.log('Update cancelled.');
                return false;
            }
        } else if (mode === 'update-and-push') {
            // backup, update locally and then push after confirmation
            console.log('creating backup...');
            const backupPath = await createRepoBackup(repo, config, runTimestamp);
            console.log(`Backup successfully created:\n  ${backupPath}`);
            console.log('\nIMPORTANT:');
            console.log(`This process will rewrite you LOCAL GIT HISTORY to permanently remove the secrets listed in:\n  ${secretsFile}`);
            console.log(`\n\nIt will then FORCE PUSH these rewritten changes to the REMOTE REPOSITORY: \n  ${repo.url}`);
            console.log('\n\nWARNING:\nThis process is potentially DESTRUCTIVE.\nIt will affect ALL USERS who have cloned or pulled from this repository.');
            console.log('\n\nAre you sure you want to rewrite history and force push?');

            const confirmed = await confirmAction('\n\n ');

            if (confirmed) {
                console.log('Updating local repository...');
                await cleanSecretsLocally(repo.path, secretsFile);
                console.log('Local repository updated successfully.');
                
                console.log('Pushing changes to remote repository...');
                await pushToRemote(repo.path, repo.url);
                console.log('Changes pushed successfully.');
            } else {
                 console.log('Update and push cancelled.');
                return false;
            }

        } else {
            return false;
        }
    } catch (error){
        console.error(`Failed: ${error.message}`);
        return false;
    }

}

async function main() {
    const mode = parseMode();
    const configFile = './config.json';

    console.log(`Secrets Removal Utility - Mode: ${mode}`);
    
    if (!run('git filter-repo --version').success) {
        console.error('Error: need to install git-filter-repo');
        process.exit(1);
    }
    
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));

    console.log(`Processing ${config.repositories.length} ${config.repositories.length > 1 ? 'repositories' : 'repository'}...`);

    for (const repo of config.repositories) {
        try {
            await cleanRepo(repo, config, mode);
        } catch (error) {
            console.error(`Error processing ${repo.name}: ${error.message}`);
        }
    }
}

main().catch(console.error);