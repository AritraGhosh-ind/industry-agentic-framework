import { Page, BrowserContext } from '@playwright/test';
import { BaseActions } from '../actions/BaseActions';

/**
 * PRODUCTION DYNAMIC LAYOUT
 * Pristine structural page objects aligned for clean verification.
 */
export class LoginPage extends BaseActions {
  // Updated locator to ensure Autopilot Self-Healing!
  public usernameField: string = "input[placeholder='Username']";

  // Corrected dynamic locator for password field
  public passwordField: string = "input[placeholder='Password']";
  public loginButton: string = "input[type='submit']";

  constructor(page: Page, context: BrowserContext) {
    super(page, context);
  }

  public async executeLoginSequence(username: string, textPassword: string): Promise<void> {
    console.log(`[POM FLOW]: Commencing login workflow with username target: ${username}`);
    
    await this.navigateTo('https://saucedemo.com');
    await this.typeInto(this.usernameField, username);
    await this.typeInto(this.passwordField, textPassword);
    await this.clickOn(this.loginButton);
  }
}