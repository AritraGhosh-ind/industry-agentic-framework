import { Page, BrowserContext } from '@playwright/test';
import { BaseActions } from '../actions/BaseActions';

/**
 * Production Page Object Model class representing the application Login screen.
 * This class serves as our target object layer for real-time surgical self-healing and code injection.
 */
export class LoginPage extends BaseActions {
  // Industry-standard string selectors mapping out our target UI input objects
  // These properties will serve as the exact baseline parameters for our locator healing agent scans
  public usernameField: string = "input[placeholder='Username']";
  public passwordField: string = "input[placeholder='Password']";
  public loginButton: string = "input[type='submit']";

  constructor(page: Page, context: BrowserContext) {
    // Invoke the parent class constructor to cleanly bind the active browser session handles
    super(page, context);
  }

  /**
   * High-level business flow wrapper executing the authentication timeline sequence.
   */
  public async executeLoginSequence(username: string, textPassword: string): Promise<void> {
    console.log(`[POM FLOW]: Commencing enterprise login workflow with username target: ${username}`);
    
    // Utilize our robust base actions layer to process the interaction steps safely
    await this.navigateTo('https://saucedemo.com');
    await this.typeInto(this.usernameField, username);
    await this.typeInto(this.passwordField, textPassword);
    await this.clickOn(this.loginButton);
    
    console.log('[POM FLOW]: Login submission sequence executed.');
  }
}