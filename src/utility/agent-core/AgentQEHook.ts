/// <reference types="node" />
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentQEGitHub } from './AgentQEGitHub';
import { BusinessOptions } from './AgentQEBusinessOptions';
import { LocatorRepair } from './AgentQELocatorRepair';
import { addChangedFile, currentGitBranch, emptyState, lineForSourceFile, normalizePath, playwrightCli, readState, writeState, type AgentState } from './agent-qe-shared';

export default class AgentQEHook implements Reporter {
  private pendingFailures: Array<{ test: TestCase; result: TestResult }> = [];
  private hadPendingBusinessAtStart = false;
  private executedTestCount = 0;
  private readonly locatorRepair = new LocatorRepair();
  private readonly businessOptions = new BusinessOptions();
  private readonly git = new AgentQEGitHub();

  onBegin(): void {
    const state = readState();
    const hasRepairState = state.correctionsMade || Boolean(state.pendingBusiness);
    if (hasRepairState) {
      const branch = currentGitBranch();
      if (!state.repairBranch || state.repairBranch !== branch) {
        console.warn(`[AGENT]: Discarding repair state not associated with the current branch "${branch}".`);
        writeState(emptyState());
        this.hadPendingBusinessAtStart = false;
      } else {
        this.hadPendingBusinessAtStart = Boolean(state.pendingBusiness);
      }
    } else {
      this.hadPendingBusinessAtStart = false;
    }
    console.log('🔬 [AGENT SYSTEM]: Monitoring Playwright test outcomes...');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') {
      this.executedTestCount += 1;
    }
    if (result.status === 'failed' || result.status === 'timedOut') {
      this.pendingFailures.push({ test, result });
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] }> {
    try {
      if (this.executedTestCount === 0) {
        console.log('[AGENT]: No tests executed; leaving workflow state and GitHub unchanged.');
        return { status: result.status };
      }

      let state = readState();
      if (state.pendingBusiness && this.hadPendingBusinessAtStart) {
        const currentPendingFailure = this.findPendingBusinessFailure(state.pendingBusiness);
        if (currentPendingFailure) {
          state.pendingBusiness = currentPendingFailure;
          writeState(state);
        }
        if (result.status === 'passed') {
          console.log('[AGENT]: The pending business-logic change was corrected manually; continuing with the passing run.');
          addChangedFile(state, normalizePath(state.pendingBusiness.sourceFile));
          delete state.pendingBusiness;
          writeState(state);
        } else if (this.isSamePendingBusinessFailure(state.pendingBusiness)) {
          const optionApplied = await this.businessOptions.offerBusinessOptions(state, state.pendingBusiness);
          if (!optionApplied) return { status: 'failed' };
          state = readState();
          const retryStatus = this.rerunPlaywright();
          if (retryStatus !== 'passed') return { status: 'failed' };
          state = readState();
          if (state.pendingBusiness) return { status: 'failed' };
          if (process.env.AGENT_QE_INTERNAL_RETRY !== '1' && state.correctionsMade) {
            await this.git.raisePullRequest(state);
          }
          return { status: 'passed' };
        } else {
          console.log('[AGENT]: The saved business failure is no longer the current failure; discarding its stale prompt.');
          delete state.pendingBusiness;
          writeState(state);
        }
      }

      if (result.status !== 'passed' && this.pendingFailures.length > 0) {
        const { test, result: failedResult } = this.pendingFailures[0];
        const error = failedResult.errors[0]?.message || '';
        if (this.locatorRepair.classifyFailure(error) === 'locator') {
          console.error('[AGENT]: Locator failures must be healed inside the active test. No post-test browser restart will be attempted.');
          return { status: 'failed' };
        }
        await this.locatorRepair.processFailure(test, failedResult, state);
        return { status: 'failed' };
      }

      state = readState();
      if (result.status === 'passed' && state.correctionsMade &&
          process.env.AGENT_QE_INTERNAL_RETRY !== '1') {
        await this.git.raisePullRequest(state);
      }
      return { status: result.status };
    } catch (error) {
      console.error('[AGENT ERROR]: Failure processing did not complete:', error);
      return { status: 'failed' };
    }
  }

  private isSamePendingBusinessFailure(pending: NonNullable<AgentState['pendingBusiness']>): boolean {
    return this.findPendingBusinessFailure(pending) !== undefined;
  }

  private findPendingBusinessFailure(
    pending: NonNullable<AgentState['pendingBusiness']>
  ): NonNullable<AgentState['pendingBusiness']> | undefined {
    for (const { test, result } of this.pendingFailures) {
      const error = result.errors[0]?.message || '';
      if (this.locatorRepair.classifyFailure(error) !== 'business' || test.title !== pending.testTitle) {
        continue;
      }
      const sourceFile = normalizePath(test.location.file);
      const stack = result.errors[0]?.stack || '';
      const line = lineForSourceFile(stack, sourceFile) ??
        (result.errors[0]?.location?.file &&
        normalizePath(result.errors[0].location.file) === sourceFile
          ? result.errors[0].location.line
          : test.location.line);
      const priorStackLine = lineForSourceFile(pending.stack, sourceFile);
      const sameStoredFailure =
        (sourceFile === normalizePath(pending.sourceFile) && line === pending.line) ||
        (priorStackLine !== undefined && priorStackLine === line);
      if (!sameStoredFailure) continue;
      return {
        ...pending,
        sourceFile: path.relative(process.cwd(), sourceFile).split(path.sep).join('/'),
        line,
        error,
        stack
      };
    }
    return undefined;
  }

  private rerunPlaywright(): FullResult['status'] {
    if (!fs.existsSync(playwrightCli)) throw new Error(`Playwright CLI not found: ${playwrightCli}`);
    const args = process.argv.slice(2);
    const testIndex = args.indexOf('test');
    const testArgs = testIndex >= 0 ? args.slice(testIndex + 1) : args;
    for (let index = testArgs.length - 1; index >= 0; index--) {
      if (testArgs[index] === '--reporter') testArgs.splice(index, 2);
      else if (testArgs[index].startsWith('--reporter=')) testArgs.splice(index, 1);
    }
    console.log('\n[AGENT]: Re-running Playwright from the beginning to verify the selected business-logic change...');
    try {
      execFileSync(process.execPath, [playwrightCli, 'test', ...testArgs], {
        stdio: 'inherit',
        env: { ...process.env, AGENT_QE_INTERNAL_RETRY: '1' }
      });
      return 'passed';
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
      if (status === 1) return 'failed';
      throw error;
    }
  }
}
