import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as https from 'node:https';
import { projectRoot, stateTrackerFile, type AgentState } from './agent-qe-shared';

export class AgentQEGitHub {
  async raisePullRequest(state: AgentState): Promise<void> {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!branch || branch === 'main' || branch === 'HEAD') {
      throw new Error(`Refusing to create a PR from branch "${branch}". Check out a feature branch first.`);
    }

    const remoteUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const repoMatch = remoteUrl.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
    if (!repoMatch) throw new Error(`Could not determine a GitHub owner/repository from origin: ${remoteUrl}`);
    const repository = repoMatch[1];
    const apiToken = process.env.GITHUB_TOKEN;
    if (!apiToken || apiToken === 'placeholder-token') {
      console.error(`[AGENT]: GITHUB_TOKEN is unavailable. After configuring it, run tests again to raise the PR.`);
      console.error(`Manual comparison: https://github.com/${repository}/compare/main...${branch}?expand=1`);
      throw new Error('Pull request creation requires GITHUB_TOKEN with repository write permission.');
    }

    const files = this.collectChangedFiles(state);
    if (files.length === 0) throw new Error('No changed files are available; refusing to create a PR.');
    console.log(`[AGENT]: Including all non-ignored working-tree changes in the PR:\n${files.map((file) => `  - ${file}`).join('\n')}`);
    execFileSync('git', ['add', '--', ...files], { stdio: 'inherit' });

    const stagedChanges = this.gitPathList(['diff', '--cached', '--name-only', '-z', '--', ...files]);
    if (stagedChanges.length > 0) {
      execFileSync('git', [
        'commit',
        '-m',
        'chore(qe-agent): apply verified locator and business-logic repairs',
        '--',
        ...files
      ], { stdio: 'inherit' });
    } else {
      throw new Error('No changes were staged for the PR; refusing to push an empty repair commit.');
    }

    execFileSync('git', ['push', 'origin', branch], { stdio: 'inherit' });
    const response = await this.sendPullRequest(repository, branch, apiToken);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 422) {
        const existingPullRequest = await this.findOpenPullRequest(repository, branch, apiToken);
        if (existingPullRequest) {
          console.log(`[AGENT]: An open pull request already covers this branch: ${existingPullRequest}`);
          if (fs.existsSync(stateTrackerFile)) fs.unlinkSync(stateTrackerFile);
          return;
        }
      }
      const detail = response.body as { message?: string };
      throw new Error(`GitHub rejected PR creation (${response.statusCode}): ${detail.message || JSON.stringify(response.body)}`);
    }
    const pullRequest = response.body as { html_url?: string };
    if (!pullRequest.html_url) throw new Error('GitHub accepted the request without returning a pull-request URL.');
    console.log(`[AGENT]: Pull request created: ${pullRequest.html_url}`);
    if (fs.existsSync(stateTrackerFile)) fs.unlinkSync(stateTrackerFile);
  }

  private collectChangedFiles(state: AgentState): string[] {
    const changed = new Set([
      ...state.changedFiles,
      ...this.gitPathList(['diff', '--name-only', '-z', 'HEAD']),
      ...this.gitPathList(['ls-files', '--others', '--exclude-standard', '-z'])
    ]);

    return [...changed].filter((file) => {
      const absolutePath = path.resolve(projectRoot, file);
      const relativePath = path.relative(projectRoot, absolutePath);
      if (path.isAbsolute(relativePath) || relativePath === '..' ||
          relativePath.startsWith(`..${path.sep}`)) {
        throw new Error(`Refusing to include a changed path outside the project: ${file}`);
      }
      return relativePath !== '';
    });
  }

  private gitPathList(args: string[]): string[] {
    const output = execFileSync('git', args, { cwd: projectRoot });
    return output.toString('utf8').split('\0').filter(Boolean);
  }

  private async findOpenPullRequest(repository: string, branch: string, token: string): Promise<string | undefined> {
    const owner = repository.split('/')[0];
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${branch}`,
      base: 'main'
    });
    const response = await this.sendGitHubRequest(
      `/repos/${repository}/pulls?${query.toString()}`,
      token
    );
    if (response.statusCode !== 200 || !Array.isArray(response.body)) {
      throw new Error(`Could not check for an existing pull request (HTTP ${response.statusCode}).`);
    }
    const existing = response.body.find((item): item is { html_url: string } =>
      typeof item === 'object' && item !== null && 'html_url' in item && typeof item.html_url === 'string'
    );
    return existing?.html_url;
  }

  private sendPullRequest(
    repository: string,
    branch: string,
    token: string
  ): Promise<{ statusCode: number; body: unknown }> {
    const payload = JSON.stringify({
      title: `chore(qe-agent): verified repairs (${branch})`,
      body: 'Automated locator and business-logic repairs verified by the Playwright test suite.',
      head: `${repository.split('/')[0]}:${branch}`,
      base: 'main'
    });

    return this.sendGitHubRequest(`/repos/${repository}/pulls`, token, 'POST', payload);
  }

  private sendGitHubRequest(
    requestPath: string,
    token: string,
    method = 'GET',
    payload?: string
  ): Promise<{ statusCode: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Agent-QE-Utility-Framework',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const request = https.request({
        hostname: 'api.github.com',
        path: requestPath,
        method,
        headers
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            reject(new Error(`GitHub returned invalid JSON (HTTP ${response.statusCode}): ${body}`));
            return;
          }
          resolve({ statusCode: response.statusCode || 0, body: parsed });
        });
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }
}
