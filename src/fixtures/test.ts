import { test as base, expect as baseExpect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { LocatorRepair } from '../utility/agent-core/AgentQELocatorRepair';
import type { DomSnapshot, LocatorCandidate, PageSource } from '../utility/agent-core/agent-qe-shared';

type AgentFixtures = {
  captureAgentDomSnapshot: void;
};

const maxPageSourceCharacters = 100_000;
const locatorRepair = new LocatorRepair();
const healedLocators = new WeakMap<object, Locator>();
let activeTest: { page: Page; testInfo: TestInfo } | undefined;

export function resolveHealedLocator(locator: Locator): Locator {
  return healedLocators.get(locator) || locator;
}

function removeFixtureFrames(failure: unknown): unknown {
  if (!(failure instanceof Error) || !failure.stack) return failure;
  failure.stack = failure.stack
    .split('\n')
    .filter((line, index) => index === 0 || !line.includes('src/fixtures/test.ts'))
    .join('\n');
  return failure;
}

function isLocator(value: unknown): value is Locator {
  return typeof value === 'object' && value !== null &&
    'page' in value && typeof value.page === 'function' &&
    'fill' in value && 'click' in value;
}

async function capturePageSource(page: Page): Promise<PageSource> {
  const pageSource = await page.content();
  const sanitizedSource = await page.evaluate((html) => {
    const documentCopy = new DOMParser().parseFromString(html, 'text/html');
    documentCopy.querySelectorAll('script, style, noscript, template').forEach((element) => element.remove());

    for (const element of documentCopy.querySelectorAll('input, textarea, select')) {
      element.removeAttribute('value');
      element.removeAttribute('checked');
      element.removeAttribute('selected');
      if (element instanceof HTMLTextAreaElement) element.textContent = '';
      element.querySelectorAll('option').forEach((option) => option.removeAttribute('selected'));
    }

    const sensitiveAttribute = /password|secret|token|auth|cookie|session|csrf|email|phone|mobile|ssn|credit|card|account|credential|api.?key/i;
    for (const element of documentCopy.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        if (sensitiveAttribute.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    }

    const textWalker = documentCopy.createTreeWalker(documentCopy, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      const node = textWalker.currentNode;
      node.textContent = (node.textContent || '')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '[REDACTED_PHONE]');
    }

    return documentCopy.documentElement.outerHTML;
  }, pageSource);
  const truncated = sanitizedSource.length > maxPageSourceCharacters;
  return {
    html: truncated ? sanitizedSource.slice(0, maxPageSourceCharacters) : sanitizedSource,
    truncated
  };
}

async function attachPageSource(page: Page, testInfo: TestInfo): Promise<void> {
  const source = await capturePageSource(page);
  await testInfo.attach('agent-page-source.json', {
    body: JSON.stringify(source),
    contentType: 'application/json'
  });
}

async function captureDomSnapshot(page: Page): Promise<DomSnapshot> {
  const nodes = await page.locator('body').evaluate((body) => {
    const elements = Array.from(body.querySelectorAll<HTMLElement>('*'));
    const roleFor = (element: HTMLElement): string | undefined => {
      const explicitRole = element.getAttribute('role');
      if (explicitRole) return explicitRole;

      const tagName = element.tagName.toLowerCase();
      if (tagName === 'button') return 'button';
      if (tagName === 'a' && element.hasAttribute('href')) return 'link';
      if (/^h[1-6]$/.test(tagName)) return 'heading';
      if (tagName === 'img') return 'img';
      if (tagName === 'textarea') return 'textbox';
      if (tagName === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      if (tagName === 'input') {
        const type = (element as HTMLInputElement).type.toLowerCase();
        if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'search') return 'searchbox';
        if (['hidden', 'password'].includes(type)) return undefined;
        return 'textbox';
      }

      return undefined;
    };
    const textFor = (element: HTMLElement): string | undefined => {
      const tagName = element.tagName.toLowerCase();
      const role = roleFor(element);
      if (element instanceof HTMLInputElement &&
          ['button', 'submit', 'reset'].includes(element.type.toLowerCase())) {
        return element.value && element.value.length <= 100 ? element.value : undefined;
      }
      if (['script', 'style', 'template', 'input', 'textarea', 'select'].includes(tagName)) return undefined;

      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ');
      const value = (element.getAttribute('aria-label') || directText || '').trim().replace(/\s+/g, ' ');
      return value && value.length <= 100 ? value : undefined;
    };
    const cssPathFor = (element: HTMLElement): string => {
      const segments: string[] = [];
      let current: HTMLElement | null = element;
      while (current && current.tagName.toLowerCase() !== 'body') {
        const tag = current.tagName.toLowerCase();
        const sameTagSiblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current!.tagName)
          : [];
        const index = sameTagSiblings.indexOf(current) + 1;
        segments.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }
      return `body > ${segments.join(' > ')}`;
    };
    const xpathFor = (element: HTMLElement): string => {
      const segments: string[] = [];
      let current: HTMLElement | null = element;
      while (current && current.tagName.toLowerCase() !== 'body') {
        const tag = current.tagName.toLowerCase();
        const sameTagSiblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current!.tagName)
          : [];
        const index = sameTagSiblings.indexOf(current) + 1;
        segments.unshift(`${tag}[${index}]`);
        current = current.parentElement;
      }
      return `//body/${segments.join('/')}`;
    };

    const nodes = elements.slice(0, 2000).map((element, index) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const labelText = element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
        ? Array.from(element.labels || []).map((label) => label.innerText.trim()).filter(Boolean).join(' ')
        : undefined;

      return {
        id: index + 1,
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        name: element.getAttribute('aria-label') || labelText || textFor(element) ||
          element.getAttribute('alt') || undefined,
        text: textFor(element),
        testId: element.getAttribute('data-testid') || undefined,
        label: labelText || undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
        alt: element.getAttribute('alt') || undefined,
        title: element.getAttribute('title') || undefined,
        elementId: element.getAttribute('id') || undefined,
        nameAttribute: element.getAttribute('name') || undefined,
        classNames: Array.from(element.classList),
        cssPath: cssPathFor(element),
        xpath: xpathFor(element),
        visible: style.display !== 'none' && style.visibility !== 'hidden' &&
          bounds.width > 0 && bounds.height > 0
      };
    });

    return { nodes, truncated: elements.length > nodes.length };
  });

  return nodes;
}

async function attachDomSnapshot(page: Page, testInfo: TestInfo): Promise<void> {
  const snapshot = await captureDomSnapshot(page);
  await testInfo.attach('agent-dom-snapshot.json', {
    body: JSON.stringify(snapshot),
    contentType: 'application/json'
  });
}

async function healFailedLocator(locator: Locator, failure: unknown): Promise<Locator | 'skip' | undefined> {
  if (!activeTest) return undefined;
  const error = failure instanceof Error ? failure.message : String(failure);
  const stack = failure instanceof Error ? failure.stack || '' : '';
  if (locatorRepair.classifyFailure(error) !== 'locator') return undefined;

  try {
    activeTest.testInfo.setTimeout(
      Math.max(activeTest.testInfo.timeout, activeTest.testInfo.duration + 120_000)
    );
    const [snapshot, pageSource] = await Promise.all([
      captureDomSnapshot(activeTest.page),
      capturePageSource(activeTest.page)
    ]);
    const selected = await locatorRepair.repairInTest(
      activeTest.testInfo.title,
      error,
      stack,
      snapshot,
      pageSource
    );
    if (selected === 'irrelevant') return 'skip';
    return selected ? activeTest.page.locator(selected.selector) : undefined;
  } catch (error) {
    console.error('[AGENT]: In-test locator repair failed; preserving the original browser session and test failure:', error);
    return undefined;
  }
}

export async function runWithLocatorHealing<T>(
  locator: Locator,
  operation: (currentLocator: Locator) => Promise<T>
): Promise<T | undefined> {
  const initialLocator = resolveHealedLocator(locator);
  try {
    return await operation(initialLocator);
  } catch (failure) {
    if (locatorRepair.classifyFailure(
      failure instanceof Error ? failure.message : String(failure)
    ) !== 'locator') {
      throw removeFixtureFrames(failure);
    }

    const repaired = await healFailedLocator(initialLocator, failure);
    if (repaired === 'skip') return undefined;
    if (!repaired) throw removeFixtureFrames(failure);
    healedLocators.set(locator, repaired);
    return operation(repaired);
  }
}

function wrapAssertion(assertion: object, locator: Locator | undefined, modifiers: string[] = []): object {
  return new Proxy(assertion, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'not' || property === 'soft') {
        return wrapAssertion(value as object, locator, [...modifiers, String(property)]);
      }
      if (typeof value !== 'function') return value;

      return async (...matcherArgs: unknown[]) => {
        try {
          return await Reflect.apply(value, target, matcherArgs);
        } catch (failure) {
          if (!locator || locatorRepair.classifyFailure(
            failure instanceof Error ? failure.message : String(failure)
          ) !== 'locator') {
            throw removeFixtureFrames(failure);
          }

          const repaired = await healFailedLocator(locator, failure);
          if (repaired === 'skip') return;
          if (!repaired) throw removeFixtureFrames(failure);
          healedLocators.set(locator, repaired);

          let retryAssertion: object = Reflect.apply(baseExpect, undefined, [repaired]) as object;
          for (const modifier of modifiers) {
            retryAssertion = Reflect.get(retryAssertion, modifier) as object;
          }
          const retryMatcher = Reflect.get(retryAssertion, property) as (...args: unknown[]) => Promise<void>;
          try {
            return await retryMatcher.apply(retryAssertion, matcherArgs);
          } catch (retryFailure) {
            throw removeFixtureFrames(retryFailure);
          }
        }
      };
    }
  });
}

export const expect: typeof baseExpect = new Proxy(baseExpect, {
  apply(target, thisArgument, argumentsList: unknown[]) {
    const [actual, ...options] = argumentsList;
    const originalLocator = isLocator(actual) ? actual : undefined;
    const resolvedActual = originalLocator ? resolveHealedLocator(originalLocator) : actual;
    const assertion = Reflect.apply(target, thisArgument, [resolvedActual, ...options]) as object;
    return wrapAssertion(assertion, originalLocator);
  },
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      const originalLocator = isLocator(args[0]) ? args[0] : undefined;
      const callArgs = originalLocator
        ? [resolveHealedLocator(originalLocator), ...args.slice(1)]
        : args;
      const assertion = Reflect.apply(value, target, callArgs) as object;
      return wrapAssertion(assertion, originalLocator);
    };
  }
});

export const test = base.extend<AgentFixtures>({
  captureAgentDomSnapshot: [async ({ page }, use, testInfo) => {
    activeTest = { page, testInfo };
    try {
      await use();
    } finally {
      activeTest = undefined;
      if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
        try {
          await testInfo.attach('failure-screenshot.png', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png'
          });
        } catch (error) {
          console.error(`[AGENT FIXTURE]: Could not attach the failure screenshot for "${testInfo.title}":`, error);
        }
        try {
          await attachPageSource(page, testInfo);
        } catch (error) {
          console.error(`[AGENT FIXTURE]: Could not attach page source for "${testInfo.title}":`, error);
        }
        await attachDomSnapshot(page, testInfo);
      }
    }
  }, { auto: true }]
});
