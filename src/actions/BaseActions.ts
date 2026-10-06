import { Page, BrowserContext, expect } from '@playwright/test';

/**
 * Enterprise Core Base Actions Wrapper Class
 * Encapsulates raw browser interactions to provide zero-flakiness execution behaviors.
 */
export class BaseActions {
  protected page: Page;
  protected context: BrowserContext;

  constructor(page: Page, context: BrowserContext) {
    this.page = page;
    this.context = context;
  }

  /**
   * Resilient element navigation helper with an implicit load safety guard.
   */
  public async navigateTo(url: string): Promise<void> {
    console.log(`[BASE ACTION]: Navigating to destination URL: ${url}`);
    await this.page.goto(url, { waitUntil: 'load', timeout: 30000 });
  }

  /**
   * High-stability element typing handler that performs visibility verification first.
   */
  public async typeInto(selector: string, text: string): Promise<void> {
    console.log(`[BASE ACTION]: Typing text values into target selector element: ${selector}`);
    const locator = this.page.locator(selector);
    await expect(locator).toBeVisible({ timeout: 10000 });
    await locator.fill(text);
  }

  /**
   * High-stability interaction clicker that performs visibility and clickability verification gates.
   */
  public async clickOn(selector: string): Promise<void> {
    console.log(`[BASE ACTION]: Executing active click action on element selector: ${selector}`);
    const locator = this.page.locator(selector);
    await expect(locator).toBeVisible({ timeout: 10000 });
    await locator.click();
  }

  /**
   * Dynamic human-intercept multi-window/tab switching router matrix handler.
   * Intercepts a newly spawned browser page event trigger, validates readiness, and switches focus.
   * 
   * @param clickTriggerAction A function representing the click operation that opens the new tab window.
   */
  public async switchWindowContextAndPerform(clickTriggerAction: () => Promise<void>): Promise<Page> {
    console.log('[BASE ACTION]: Preparing background event intercepts for dynamic window switching...');
    
    // Start tracking the window/tab open event in the active browser context profile
    const windowPromise = this.context.waitForEvent('page');
    
    // Fire off the click action parameter that causes the new window to pop open
    await clickTriggerAction();
    
    // Halt call-stack execution until the browser processes the new tab memory stream completely
    const newPageWindow = await windowPromise;
    
    // Force the new window frame to wait until the document tree is completely built
    await newPageWindow.waitForLoadState('load');
    console.log(`[BASE ACTION]: Focus successfully shifted to new page window destination: ${newPageWindow.url()}`);
    
    return newPageWindow;
  }
}