/// <reference types="node" />
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestResult } from '@playwright/test/reporter';
import { OpenAI } from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();

export const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'placeholder-gate-key' });
export const projectRoot = process.cwd();
export const sourceRoot = path.join(projectRoot, 'src');
export const stateTrackerFile = path.join(projectRoot, '.agent_qe_state.json');
export const playwrightCli = path.join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');

export interface DomNode {
  id: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  alt?: string;
  title?: string;
  elementId?: string;
  nameAttribute?: string;
  classNames: string[];
  cssPath: string;
  xpath: string;
  visible: boolean;
}

export interface DomSnapshot {
  nodes: DomNode[];
  truncated: boolean;
}

export interface PendingBusinessFailure {
  testTitle: string;
  sourceFile: string;
  line: number;
  error: string;
  stack: string;
  domSnapshot: DomSnapshot;
}

export interface AgentState {
  correctionsMade: boolean;
  changedFiles: string[];
  pendingBusiness?: PendingBusinessFailure;
}

export interface LocatorTarget {
  filePath: string;
  sourceKind: 'page-property' | 'page-locator-call';
  currentSelector: string;
  propertyName?: string;
  locatorReceiver?: string;
}

export interface LocatorCandidate {
  nodeId: number;
  rank: number;
  replacement: string;
  description: string;
}

export interface BusinessOption {
  id: number;
  description: string;
  textToReplace: string;
  replacementText: string;
}

export function emptyState(): AgentState {
  return { correctionsMade: false, changedFiles: [] };
}

export function readState(): AgentState {
  if (!fs.existsSync(stateTrackerFile)) return emptyState();

  const parsed: unknown = JSON.parse(fs.readFileSync(stateTrackerFile, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('changedFiles' in parsed) ||
      !Array.isArray(parsed.changedFiles) || !('correctionsMade' in parsed) ||
      typeof parsed.correctionsMade !== 'boolean') {
    throw new Error(`Invalid Agent QE state file: ${stateTrackerFile}`);
  }

  const state = parsed as AgentState;
  if (!state.changedFiles.every((file) => typeof file === 'string')) {
    throw new Error(`Invalid changedFiles entry in ${stateTrackerFile}`);
  }
  if (state.pendingBusiness !== undefined) {
    const pending = state.pendingBusiness;
    if (typeof pending !== 'object' || pending === null ||
        typeof pending.testTitle !== 'string' || typeof pending.sourceFile !== 'string' ||
        typeof pending.line !== 'number' || typeof pending.error !== 'string' ||
        typeof pending.stack !== 'string' || typeof pending.domSnapshot !== 'object' ||
        pending.domSnapshot === null || !Array.isArray(pending.domSnapshot.nodes) ||
        typeof pending.domSnapshot.truncated !== 'boolean') {
      throw new Error(`Invalid pendingBusiness entry in ${stateTrackerFile}`);
    }
  }
  return state;
}

export function writeState(state: AgentState): void {
  fs.writeFileSync(stateTrackerFile, JSON.stringify(state, null, 2), 'utf8');
}

export function addChangedFile(state: AgentState, filePath: string): void {
  const relativePath = path.relative(projectRoot, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to track a repair outside the project: ${filePath}`);
  }
  const normalized = relativePath.split(path.sep).join('/');
  if (!state.changedFiles.includes(normalized)) state.changedFiles.push(normalized);
  state.correctionsMade = true;
}

export function decodeQuotedValue(value: string): string | undefined {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) return undefined;

  let decoded = '';
  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      const next = value[++index];
      decoded += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
    } else if (character === quote) {
      return decoded;
    } else {
      decoded += character;
    }
  }
  return undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function encodeString(value: string, quote: string): string {
  return `${quote}${value.replace(/\\/g, '\\\\').replace(new RegExp(escapeRegExp(quote), 'g'), `\\${quote}`)}${quote}`;
}

export function normalizePath(filePath: string): string {
  return path.resolve(projectRoot, filePath);
}

export function isWithinSourceRoot(filePath: string): boolean {
  const relative = path.relative(sourceRoot, filePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function collectSourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(entryPath));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

export function parseDomSnapshot(result: TestResult): DomSnapshot | undefined {
  const attachment = result.attachments.find((item) => item.name === 'agent-dom-snapshot.json');
  if (attachment) {
    const contents = attachment.body
      ? attachment.body.toString('utf8')
      : attachment.path
        ? fs.readFileSync(attachment.path, 'utf8')
        : undefined;
    if (!contents) throw new Error('The attached DOM snapshot did not contain readable data.');
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null || !('nodes' in parsed) ||
        !Array.isArray(parsed.nodes) || !('truncated' in parsed) ||
        typeof parsed.truncated !== 'boolean') {
      throw new Error('The attached DOM snapshot has an invalid shape.');
    }
    return parsed as DomSnapshot;
  }

  const contextPath = result.attachments.find((item) => item.name === 'error-context.md')?.path;
  if (!contextPath || !fs.existsSync(contextPath)) return undefined;
  const context = fs.readFileSync(contextPath, 'utf8');
  const nodes: DomNode[] = [];
  const roleLine = /^\s*-\s+(button|link|textbox|searchbox|checkbox|radio|heading|img|combobox)\s+"([^"]+)"/gm;
  for (const match of context.matchAll(roleLine)) {
    nodes.push({
      id: nodes.length + 1,
      tag: match[1],
      role: match[1],
      name: match[2],
      text: match[2],
      classNames: [],
      cssPath: '',
      xpath: '',
      visible: true
    });
  }
  return nodes.length > 0 ? { nodes, truncated: true } : undefined;
}

export function accessibleName(node: DomNode): string | undefined {
  return node.name || node.label || node.text;
}

export function quoteSelectorValue(value: string): string {
  return JSON.stringify(value);
}

export function cssEscape(value: string): string {
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

export function candidatesForSnapshot(snapshot: DomSnapshot, target: LocatorTarget): LocatorCandidate[] {
  if (snapshot.truncated) {
    throw new Error('The DOM snapshot was truncated; uniqueness cannot be proven, so automatic locator repair is unsafe.');
  }

  const visibleNodes = snapshot.nodes.filter((node) => node.visible);
  const raw: LocatorCandidate[] = [];
  const pageObjectSelector = target.sourceKind === 'page-property';
  const receiver = target.locatorReceiver || 'page';
  const add = (node: DomNode, rank: number, selector: string, description: string) => {
    if (!selector) return;
    let replacement = selector;
    if (!pageObjectSelector) {
      const value = quoteSelectorValue(selector);
      switch (rank) {
        case 1: {
          const name = accessibleName(node);
          replacement = `${receiver}.getByRole(${quoteSelectorValue(node.role!)}, { name: ${quoteSelectorValue(name!)}, exact: true })`;
          break;
        }
        case 2: replacement = `${receiver}.getByTestId(${quoteSelectorValue(node.testId!)})`; break;
        case 3: replacement = `${receiver}.getByLabel(${quoteSelectorValue(node.label!)}, { exact: true })`; break;
        case 4: replacement = `${receiver}.getByPlaceholder(${quoteSelectorValue(node.placeholder!)}, { exact: true })`; break;
        case 5: replacement = `${receiver}.getByText(${quoteSelectorValue(node.text!)}, { exact: true })`; break;
        case 6: replacement = `${receiver}.getByAltText(${quoteSelectorValue(node.alt!)}, { exact: true })`; break;
        case 7: replacement = `${receiver}.getByTitle(${quoteSelectorValue(node.title!)}, { exact: true })`; break;
        default: replacement = `${receiver}.locator(${value})`;
      }
    }
    raw.push({ nodeId: node.id, rank, replacement, description });
  };

  for (const node of snapshot.nodes) {
    const name = accessibleName(node);
    if (node.role && name) add(node, 1, `role=${node.role}[name=${quoteSelectorValue(name)}]`, `${node.role} named "${name}"`);
    if (node.testId) add(node, 2, `[data-testid=${quoteSelectorValue(node.testId)}]`, `test id "${node.testId}"`);
    if (node.label && node.cssPath) add(node, 3, `css=${node.cssPath}`, `associated label "${node.label}"`);
    if (node.placeholder) add(node, 4, `[placeholder=${quoteSelectorValue(node.placeholder)}]`, `placeholder "${node.placeholder}"`);
    if (node.text) add(node, 5, `text=${quoteSelectorValue(node.text)}`, `text "${node.text}"`);
    if (node.alt) add(node, 6, `${node.tag}[alt=${quoteSelectorValue(node.alt)}]`, `alt text "${node.alt}"`);
    if (node.title) add(node, 7, `[title=${quoteSelectorValue(node.title)}]`, `title "${node.title}"`);
    if (node.elementId) add(node, 8, `[id=${quoteSelectorValue(node.elementId)}]`, `id "${node.elementId}"`);
    if (node.nameAttribute) add(node, 9, `[name=${quoteSelectorValue(node.nameAttribute)}]`, `name "${node.nameAttribute}"`);
    for (const className of node.classNames) {
      add(node, 10, `.${cssEscape(className)}`, `class "${className}"`);
    }
    if (node.cssPath) add(node, 11, `css=${node.cssPath}`, `CSS path ${node.cssPath}`);
    if (node.xpath) add(node, 12, `xpath=${node.xpath}`, `XPath ${node.xpath}`);
  }

  const counts = new Map<string, number>();
  for (const candidate of raw) {
    const key = `${candidate.rank}\u0000${candidate.replacement}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return raw.filter((candidate) =>
    visibleNodes.some((node) => node.id === candidate.nodeId) &&
    counts.get(`${candidate.rank}\u0000${candidate.replacement}`) === 1
  );
}
