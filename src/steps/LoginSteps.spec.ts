import { test, expect } from '../fixtures/test';
import { LoginPage } from '../pages/LoginPage';

/**
 * Enterprise Step Definitions Layer
 * Acts as the orchestration bridge connecting Playwright specs to the Page Object layers.
 */
test.describe('Enterprise E2E Authentication Flow Suite', () => {

  test('TC_001 - Verify valid user authentication sequence matches UI contracts', async ({ page, context }) => {
    console.log('[STEP RUNNER]: Initializing Page Object instances with active session handles...');
    
    // Instantiate our industry-grade LoginPage component
    const loginPage = new LoginPage(page, context);

    // Execute the high-level business flow wrapper using standard secure target parameters
    await loginPage.executeLoginSequence('standard_user', 'secret_sauce');

    // Verification Step: Validate that the user was successfully redirected past the login gate
    console.log('[STEP RUNNER]: Validating redirection URL state match...');
    await expect(page).toHaveURL(/.*inventory.html/, { timeout: 15000 });
    
    // Layout Validation: Ensure the product catalog landing elements are fully visible
    const productHeader = page.locator("span.title:has-text('Products')");
    await expect(productHeader).toBeVisible({ timeout: 10000 });
    await expect(productHeader).toHaveText('Products');

    
    console.log('[STEP RUNNER]: Test Case TC_001 successfully executed and verified green.');
  });
});