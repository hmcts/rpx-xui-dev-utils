#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

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

async function cleanSecrets(repoPath, repoUrl, secretsFile) {
    const tempSecretsToRemovePath = path.join(repoPath, 'secrets-to-remove.txt');
    
    await fs.copyFile(secretsFile, tempSecretsToRemovePath);
    
    const result = run('git filter-repo --replace-text secrets-to-remove.txt --force', repoPath);
    
    await fs.unlink(tempSecretsToRemovePath);
    
    if (!result.success) {
        throw new Error(`git-filter-repo failed: ${result.error}`);
    }

    const remoteCheck = run('git remote -v', repoPath);

    if (!remoteCheck.success || !remoteCheck.output.includes('origin')) {
        const remoteAdded = run(`git remote add origin ${repoUrl}`, repoPath);

        if (!remoteAdded.success) {
            throw new Error(`failed to add origin remote: ${remoteAdded.error}`);
        }
    }
    
    run('git push --force --all origin', repoPath);
}

async function cleanRepo(repo, config) {
    console.log(`processing: ${repo.name}`);

    const runTimestamp = getTimestamp();

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
        await cleanSecrets(repo.path, repo.url, secretsFile);
        console.log('secret cleanup completed...');
        
        return true;
    } catch (error) {
        console.error(`failed: ${error.message}`);
        return false;
    }
}

async function main() {
    const configFile = './config.json';
    
    if (!run('git filter-repo --version').success) {
        console.error('need to install git-filter-repo');
        process.exit(1);
    }
    
    const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    
    console.log('secret cleanup starting...');
    
    for (const repo of config.repositories) {
        try {
            await cleanRepo(repo, config);
        } catch (error) {
            console.error(`error processing ${repo.name}: ${error.message}`);
        }
    }
}

main().catch(console.error);