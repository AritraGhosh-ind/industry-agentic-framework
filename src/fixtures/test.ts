import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

type AgentFixtures = {
  captureAgentDomSnapshot: void;
};

async function attachDomSnapshot(page: Page, testInfo: TestInfo): Promise<void> {
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

  await testInfo.attach('agent-dom-snapshot.json', {
    body: JSON.stringify(nodes),
    contentType: 'application/json'
  });
}

export const test = base.extend<AgentFixtures>({
  captureAgentDomSnapshot: [async ({ page }, use, testInfo) => {
    await use();
    if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
      try {
        await testInfo.attach('failure-screenshot.png', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png'
        });
      } catch (error) {
        console.error(`[AGENT FIXTURE]: Could not attach the failure screenshot for "${testInfo.title}":`, error);
      }
      await attachDomSnapshot(page, testInfo);
    }
  }, { auto: true }]
});

export { expect };
