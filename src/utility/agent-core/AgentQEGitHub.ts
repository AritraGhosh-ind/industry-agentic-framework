import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as https from 'node:https';
import { buildAgentSystemPrompt, openaiClient, projectRoot, stateTrackerFile, type AgentState } from './agent-qe-shared';

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
    const existingFiles = files.filter((file) => fs.existsSync(path.resolve(projectRoot, file)));
    const missingFiles = files.filter((file) => !fs.existsSync(path.resolve(projectRoot, file)));
    if (existingFiles.length > 0) {
      execFileSync('git', ['add', '-A', '--', ...existingFiles], { stdio: 'inherit' });
    }
    if (missingFiles.length > 0) {
      const indexedMissingFiles = this.gitPathList(['ls-files', '--cached', '-z', '--', ...missingFiles]);
      if (indexedMissingFiles.length > 0) {
        execFileSync('git', ['add', '-u', '--', ...indexedMissingFiles], { stdio: 'inherit' });
      }
    }

    const stagedChanges = this.gitPathList(['diff', '--cached', '--name-only', '-z', '--', ...files]);
    if (stagedChanges.length > 0) {
      const commitMessage = await this.createUserFacingCommitMessage(stagedChanges);
      execFileSync('git', [
        'commit',
        '-m', commitMessage.subject,
        '-m', commitMessage.body,
        '--',
        ...files
      ], { stdio: 'inherit' });
    } else {
      const existingPullRequest = await this.findOpenPullRequest(repository, branch, apiToken);
      if (existingPullRequest) {
        console.log(`[AGENT]: No new changes to commit; an open pull request already covers this branch: ${existingPullRequest}`);
        if (fs.existsSync(stateTrackerFile)) fs.unlinkSync(stateTrackerFile);
        return;
      }

      const commitsAheadOfBase = Number(execFileSync(
        'git',
        ['rev-list', '--count', 'origin/main..HEAD'],
        { cwd: projectRoot, encoding: 'utf8' }
      ).trim());
      if (!Number.isInteger(commitsAheadOfBase) || commitsAheadOfBase < 0) {
        throw new Error(`Could not determine whether branch "${branch}" contains commits ahead of origin/main.`);
      }
      if (commitsAheadOfBase === 0) {
        console.log('[AGENT]: No new changes to commit and no branch commits ahead of origin/main; no PR is needed.');
        if (fs.existsSync(stateTrackerFile)) fs.unlinkSync(stateTrackerFile);
        return;
      }
      console.log(`[AGENT]: No new working-tree changes; preparing a PR from ${commitsAheadOfBase} existing branch commit(s).`);
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

  private async createUserFacingCommitMessage(files: string[]): Promise<{ subject: string; body: string }> {
    const testTitles = files.flatMap((file) => {
      if (!/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file)) return [];
      const source = fs.readFileSync(path.resolve(projectRoot, file), 'utf8');
      return [...source.matchAll(/\b(?:test|it)\s*\(\s*(['"`])([^'"`]{8,180})\1/g)]
        .map((match) => match[2]);
    }).slice(0, 20);

    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: buildAgentSystemPrompt('Write a concise, human-readable Git commit message about the user-visible or business-level outcome of the staged changes. Do not mention implementation details, selectors, DOM tags, filenames, or low-level refactoring. The subject and body must not contain any of these terms or file references: div, span, xpath, css selector, locator, selector, DOM node, src/, .tsx, .ts, .spec, .md. Use only the supplied file paths and test titles; do not infer unsupported behavior. Return JSON with subject and body strings.')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Summarize the staged change scope without receiving or inspecting source diffs.',
            changedFiles: files,
            relatedTestTitles: testTitles,
            constraints: {
              subject: 'Imperative, maximum 72 characters, no prefix like feat: or chore:',
              body: 'One or two plain-language sentences describing the outcome and verification scope. If the metadata is insufficient, state the change scope conservatively.',
              prohibitedTerms: ['div', 'span', 'xpath', 'css selector', 'locator', 'selector', 'DOM node', 'src/', '.tsx', '.ts', '.spec', '.md']
            },
            output: { subject: 'string', body: 'string' }
          })
        }
      ]
    });

    // Anthropic Claude API equivalent using anthropicClient from agent-qe-shared.ts:
    // const claudeResponse = await anthropicClient.messages.create({
    //   model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    //   max_tokens: 512,
    //   system: 'Write a concise business-level commit message. Return JSON with subject and body.',
    //   messages: [{
    //     role: 'user',
    //     content: JSON.stringify({ changedFiles: files, relatedTestTitles: testTitles })
    //   }]
    // });
    // const claudeContent = claudeResponse.content.find((block) => block.type === 'text')?.text;
    // const claudeMessage = claudeContent ? JSON.parse(claudeContent) : undefined;

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Commit-message generation returned an empty response; no commit was created.');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null ||
        !('subject' in parsed) || typeof parsed.subject !== 'string' ||
        !('body' in parsed) || typeof parsed.body !== 'string') {
      throw new Error('Commit-message generation returned an invalid subject/body shape; no commit was created.');
    }
    const subject = parsed.subject.trim();
    const body = parsed.body.trim();
    const message = `${subject}\n${body}`;
    const validationErrors = [
      !subject ? 'subject is empty' : '',
      subject.length > 72 ? 'subject exceeds 72 characters' : '',
      /[\r\n]/.test(subject) ? 'subject contains a line break' : '',
      !body ? 'body is empty' : '',
      /\b(?:div|span|xpath|css selector|locator|selector|DOM node)\b|(?:src\/|\.tsx?\b|\.spec\b|\.md\b)/i.test(message)
        ? 'message contains implementation-specific terminology or a source-file reference'
        : ''
    ].filter(Boolean);
    if (validationErrors.length > 0) {
      throw new Error(`Commit-message generation failed validation (${validationErrors.join('; ')}); no commit was created.`);
    }
    console.log(`[AGENT]: Generated commit message: ${subject}`);
    return { subject, body };
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
