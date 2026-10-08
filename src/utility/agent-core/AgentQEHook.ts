/// <reference types="node" />
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AgentQEGitHub } from './AgentQEGitHub';
import { BusinessOptions } from './AgentQEBusinessOptions';
import { LocatorRepair } from './AgentQELocatorRepair';
import { addChangedFile, normalizePath, playwrightCli, readState, writeState, type AgentState } from './agent-qe-shared';

export default class AgentQEHook implements Reporter {
  private pendingFailures: Array<{ test: TestCase; result: TestResult }> = [];
  private hadPendingBusinessAtStart = false;
  private executedTestCount = 0;
  private readonly locatorRepair = new LocatorRepair();
  private readonly businessOptions = new BusinessOptions();
  private readonly git = new AgentQEGitHub();

  onBegin(): void {
    this.hadPendingBusinessAtStart = Boolean(readState().pendingBusiness);
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
        const outcome = await this.locatorRepair.processFailure(test, failedResult, state);
        if (outcome === 'locator-repaired' || outcome === 'locator-commented') {
          const retryStatus = this.rerunPlaywright();
          if (retryStatus !== 'passed') return { status: 'failed' };
          state = readState();
          if (state.pendingBusiness) return { status: 'failed' };
          if (process.env.AGENT_QE_INTERNAL_RETRY !== '1' && state.correctionsMade) {
            await this.git.raisePullRequest(state);
          }
          return { status: 'passed' };
        }
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
    return this.pendingFailures.some(({ test, result }) => {
      const error = result.errors[0]?.message || '';
      if (this.locatorRepair.classifyFailure(error) !== 'business' || test.title !== pending.testTitle) {
        return false;
      }
      const location = result.errors[0]?.location;
      const sourceFile = normalizePath(location?.file || test.location.file);
      return sourceFile === normalizePath(pending.sourceFile) &&
        (location?.line || test.location.line) === pending.line;
    });
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
    console.log('\n[AGENT]: Re-running Playwright to continue from the repaired failure...');
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
