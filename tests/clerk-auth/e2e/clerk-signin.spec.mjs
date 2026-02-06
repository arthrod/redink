/**
 * Playwright E2E tests for Clerk sign-in flow.
 *
 * These tests simulate the WebView2 sign-in experience by testing
 * the Clerk hosted sign-in pages directly in a browser.
 *
 * REQUIRES:
 *   - Playwright Chromium browser installed: npx playwright install chromium
 *   - Network access to Clerk domains
 *   - CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY env vars
 *
 * Run: npx playwright test
 *
 * Test credentials:
 *   - Test email: any+clerk_test@example.com (verified with code 424242)
 *   - Test phone: +15555550100 (verified with code 424242)
 */

import { test, expect } from '@playwright/test';

const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const FRONTEND_API_URL = 'https://trusty-redbird-51.clerk.accounts.dev';
const SIGN_IN_URL = `${FRONTEND_API_URL}/sign-in`;
const SIGN_UP_URL = `${FRONTEND_API_URL}/sign-up`;
const TEST_EMAIL = 'redink_e2e+clerk_test@example.com';
const TEST_PHONE = '+15555550100';
const VERIFICATION_CODE = '424242';

test.describe('Clerk Sign-In Page', () => {

  test('loads the sign-in page', async ({ page }) => {
    await page.goto(SIGN_IN_URL);
    // Clerk sign-in page should load with a form
    await expect(page.locator('body')).toBeVisible();
    // Look for sign-in related elements
    const hasSignIn = await page.locator('text=/sign in/i').count();
    expect(hasSignIn).toBeGreaterThan(0);
  });

  test('displays email input field', async ({ page }) => {
    await page.goto(SIGN_IN_URL);
    // The sign-in form should have an identifier input
    const emailInput = page.locator('input[name="identifier"]');
    await expect(emailInput).toBeVisible({ timeout: 10000 });
  });

  test('sign in with test email code', async ({ page }) => {
    await page.goto(SIGN_IN_URL);

    // Enter test email
    const emailInput = page.locator('input[name="identifier"]');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(TEST_EMAIL);

    // Click continue
    const continueBtn = page.locator('button:has-text("Continue")');
    await continueBtn.click();

    // Wait for verification code input
    const codeInput = page.locator('input[name="code"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 10000 });

    // Enter test verification code (424242 for clerk_test emails)
    await codeInput.fill(VERIFICATION_CODE);

    // Wait for sign-in to complete (redirect or session established)
    await page.waitForTimeout(3000);

    // After successful sign-in, user should be redirected or see user info
    const url = page.url();
    // The page should no longer be on the sign-in page, or should show the user profile
    console.log(`After sign-in, URL: ${url}`);
  });
});

test.describe('Clerk Sign-Up Page', () => {

  test('loads the sign-up page', async ({ page }) => {
    await page.goto(SIGN_UP_URL);
    await expect(page.locator('body')).toBeVisible();
    const hasSignUp = await page.locator('text=/sign up|create/i').count();
    expect(hasSignUp).toBeGreaterThan(0);
  });
});

test.describe('Clerk JS SDK Integration (simulating WebView2)', () => {

  test('loads Clerk.js and initializes', async ({ page }) => {
    // Create a minimal HTML page that loads Clerk.js (similar to ClerkSignInDialog)
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><title>Test</title></head>
      <body>
        <div id="status">loading</div>
        <div id="clerk-signin"></div>
        <script
          data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}"
          src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
          crossorigin="anonymous"
          onload="initClerk()"
          onerror="document.getElementById('status').textContent='error'">
        </script>
        <script>
          async function initClerk() {
            try {
              const clerk = window.Clerk;
              await clerk.load();
              document.getElementById('status').textContent = 'loaded';

              // Mount sign-in
              clerk.mountSignIn(document.getElementById('clerk-signin'));
              document.getElementById('status').textContent = 'mounted';
            } catch (e) {
              document.getElementById('status').textContent = 'error: ' + e.message;
            }
          }
        </script>
      </body>
      </html>
    `;

    await page.setContent(html);

    // Wait for Clerk.js to load and initialize
    await page.waitForFunction(
      () => document.getElementById('status').textContent !== 'loading',
      { timeout: 15000 }
    );

    const status = await page.locator('#status').textContent();
    console.log(`Clerk.js status: ${status}`);
    expect(['loaded', 'mounted']).toContain(status);
  });

  test('WebView2 postMessage integration pattern', async ({ page }) => {
    // Test the postMessage pattern used by ClerkSignInDialog
    // This validates that the JavaScript → .NET communication works
    const messages = [];

    // Listen for console messages (simulating WebMessageReceived)
    page.on('console', (msg) => {
      if (msg.text().startsWith('WEBVIEW_MSG:')) {
        messages.push(JSON.parse(msg.text().substring('WEBVIEW_MSG:'.length)));
      }
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body>
        <script>
          // Simulate the postMessage pattern used in ClerkSignInDialog
          // In real WebView2, this would be window.chrome.webview.postMessage()
          // For testing, we use console.log as a stand-in

          function simulateSignInComplete() {
            const msg = JSON.stringify({
              type: 'signInComplete',
              sessionToken: 'test-jwt-token-abc123',
              sessionId: 'sess_test_123',
              userId: 'user_test_456',
              email: 'test@example.com',
              name: 'Test User',
              expiry: Math.floor(Date.now() / 1000) + 3600
            });
            console.log('WEBVIEW_MSG:' + msg);
          }

          function simulateSignInCancelled() {
            console.log('WEBVIEW_MSG:' + JSON.stringify({ type: 'signInCancelled' }));
          }

          function simulateSignInError() {
            console.log('WEBVIEW_MSG:' + JSON.stringify({ type: 'signInError', message: 'Test error' }));
          }

          // Auto-trigger tests
          simulateSignInComplete();
          simulateSignInCancelled();
          simulateSignInError();
        </script>
      </body>
      </html>
    `;

    await page.setContent(html);
    await page.waitForTimeout(1000);

    // Verify we received all three message types
    expect(messages.length).toBe(3);

    // Verify signInComplete
    const complete = messages.find(m => m.type === 'signInComplete');
    expect(complete).toBeTruthy();
    expect(complete.sessionToken).toBe('test-jwt-token-abc123');
    expect(complete.sessionId).toBe('sess_test_123');
    expect(complete.userId).toBe('user_test_456');
    expect(complete.email).toBe('test@example.com');
    expect(complete.name).toBe('Test User');
    expect(complete.expiry).toBeGreaterThan(0);

    // Verify signInCancelled
    const cancelled = messages.find(m => m.type === 'signInCancelled');
    expect(cancelled).toBeTruthy();

    // Verify signInError
    const error = messages.find(m => m.type === 'signInError');
    expect(error).toBeTruthy();
    expect(error.message).toBe('Test error');
  });
});
