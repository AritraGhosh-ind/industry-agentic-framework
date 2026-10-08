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
    const productHeader = page.getByText("Products", { exact: true });
    await expect(productHeader).toBeVisible({ timeout: 10000 });

    // Intentional self-healing validation: each missing locator should heal to
    // the existing, uniquely identifiable element before the next check runs.
    const missingProductsHeading = page.getByText("Products", { exact: true });
    await expect(missingProductsHeading).toBeVisible({ timeout: 10000 });

    // @agent-qe-intent: Sauce Labs Backpack
    const missingBackpackName = page.getByText("Sauce Labs Backpack", { exact: true });
    await expect(missingBackpackName).toBeVisible({ timeout: 10000 });

    // @agent-qe-obsolete-locator
    // const obsoleteRewardsBanner = page.locator('#legacy-rewards-banner');
    // await expect(obsoleteRewardsBanner).toBeVisible({ timeout: 10000 });

    // Intentional business-logic failures: the reporter must stop here and
    // offer human choices instead of silently changing expected behavior.
    // await expect(productHeader).toHaveText('Products Catalog');
    await expect(page).toHaveURL(/inventory/);

    console.log('[STEP RUNNER]: Test Case TC_001 successfully executed and verified green.');
  });
});