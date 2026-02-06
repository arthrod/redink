/**
 * E2E tests for the Clerk sign-in flow — against the local mock server.
 *
 * These tests are the offline equivalent of clerk-signin.spec.mjs: they exercise
 * the same sign-in UI flow and WebView2 postMessage integration, but using the
 * mock Clerk server so no network access or real Clerk.js SDK is needed.
 *
 * Run: npx playwright test e2e/clerk-signin-mock.spec.mjs
 */

import { test, expect } from '@playwright/test';
import { startMockClerk, stopMockClerk } from '../mock-server/clerk-mock.mjs';

let BASE_URL;
let SECRET_KEY;
const TEST_EMAIL = 'redink_e2e+clerk_test@example.com';
const VERIFICATION_CODE = '424242';

test.beforeAll(async () => {
  const info = await startMockClerk(0, 'sk_test_e2e_mock');
  BASE_URL = info.baseUrl;
  SECRET_KEY = info.secretKey;
});

test.afterAll(async () => {
  await stopMockClerk();
});

// ─── Sign-In Page ─────────────────────────────────────────────────────────────

test.describe('Clerk Sign-In Page (mock)', () => {

  test('loads the sign-in page', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);
    await expect(page.locator('body')).toBeVisible();
    // Should have a "Sign in" heading
    const heading = page.locator('h1');
    await expect(heading).toHaveText('Sign in');
  });

  test('displays email input field', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);
    const emailInput = page.locator('input[name="identifier"]');
    await expect(emailInput).toBeVisible({ timeout: 5000 });
    await expect(emailInput).toHaveAttribute('type', 'email');
  });

  test('shows verification form after entering email', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);

    // Enter email
    const emailInput = page.locator('input[name="identifier"]');
    await emailInput.fill(TEST_EMAIL);

    // Submit
    await page.locator('button[type="submit"]').click();

    // Verification form should appear
    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible({ timeout: 5000 });

    // Original form should be hidden
    await expect(page.locator('#sign-in-form')).toBeHidden();
  });

  test('sign-in with test email and verification code 424242', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);

    // Enter email
    await page.locator('input[name="identifier"]').fill(TEST_EMAIL);
    await page.locator('button[type="submit"]').click();

    // Enter verification code
    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible({ timeout: 5000 });
    await codeInput.fill(VERIFICATION_CODE);
    await page.locator('#verify-btn').click();

    // Result should appear showing completion
    const result = page.locator('#result');
    await expect(result).toBeVisible({ timeout: 5000 });

    const resultText = await result.textContent();
    const resultData = JSON.parse(resultText);
    expect(resultData.status).toBe('complete');
    expect(resultData.session_id).toMatch(/^sess_/);
    expect(resultData.user_id).toMatch(/^user_/);
    expect(resultData.session_token).toBeTruthy();
    expect(resultData.session_token.split('.').length).toBe(3); // JWT format
    expect(resultData.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('rejects wrong verification code', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);

    await page.locator('input[name="identifier"]').fill(TEST_EMAIL);
    await page.locator('button[type="submit"]').click();

    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible({ timeout: 5000 });
    await codeInput.fill('000000'); // Wrong code
    await page.locator('#verify-btn').click();

    const result = page.locator('#result');
    await expect(result).toBeVisible({ timeout: 5000 });

    const resultText = await result.textContent();
    const resultData = JSON.parse(resultText);
    expect(resultData.status).toBe('failed');
    expect(resultData.errors[0].code).toBe('form_code_incorrect');
  });

  test('non-test email is rejected (no +clerk_test)', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`);

    await page.locator('input[name="identifier"]').fill('regular@example.com');
    await page.locator('button[type="submit"]').click();

    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible({ timeout: 5000 });
    await codeInput.fill(VERIFICATION_CODE);
    await page.locator('#verify-btn').click();

    const result = page.locator('#result');
    await expect(result).toBeVisible({ timeout: 5000 });

    const resultText = await result.textContent();
    const resultData = JSON.parse(resultText);
    expect(resultData.status).toBe('failed');
  });
});

// ─── Sign-Up Page ─────────────────────────────────────────────────────────────

test.describe('Clerk Sign-Up Page (mock)', () => {

  test('loads the sign-up page', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-up`);
    await expect(page.locator('body')).toBeVisible();
    const heading = page.locator('h1');
    await expect(heading).toContainText('Create your account');
  });

  test('has email, first name, and last name inputs', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-up`);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="first_name"]')).toBeVisible();
    await expect(page.locator('input[name="last_name"]')).toBeVisible();
  });

  test('has link to sign-in page', async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-up`);
    const link = page.locator('a[href="/sign-in"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Sign in');
  });
});

// ─── Clerk.js SDK Stub ───────────────────────────────────────────────────────

test.describe('Clerk JS SDK Integration — mock stub (simulating WebView2)', () => {

  test('loads Clerk.js stub and initializes', async ({ page }) => {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Test</title></head>
<body>
  <div id="status">loading</div>
  <div id="clerk-signin"></div>
  <script src="${BASE_URL}/clerk.js" onload="initClerk()" onerror="document.getElementById('status').textContent='error'"></script>
  <script>
    async function initClerk() {
      try {
        const clerk = window.Clerk;
        await clerk.load();
        document.getElementById('status').textContent = 'loaded';
        clerk.mountSignIn(document.getElementById('clerk-signin'));
        document.getElementById('status').textContent = 'mounted';
      } catch (e) {
        document.getElementById('status').textContent = 'error: ' + e.message;
      }
    }
  </script>
</body>
</html>`;

    await page.setContent(html);
    await page.waitForFunction(
      () => document.getElementById('status').textContent !== 'loading',
      { timeout: 10000 },
    );

    const status = await page.locator('#status').textContent();
    expect(['loaded', 'mounted']).toContain(status);

    // The mounted component should be in the DOM
    if (status === 'mounted') {
      const mounted = page.locator('[data-testid="clerk-signin-mounted"]');
      await expect(mounted).toBeVisible();
    }
  });

  test('Clerk stub exposes expected API surface', async ({ page }) => {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="result"></div>
  <script src="${BASE_URL}/clerk.js"></script>
  <script>
    window.addEventListener('clerk-loaded', () => {
      const result = {
        hasClerk: !!window.Clerk,
        hasLoad: typeof window.Clerk.load === 'function',
        hasMountSignIn: typeof window.Clerk.mountSignIn === 'function',
        hasMountSignUp: typeof window.Clerk.mountSignUp === 'function',
        sessionIsNull: window.Clerk.session === null,
        userIsNull: window.Clerk.user === null,
      };
      document.getElementById('result').textContent = JSON.stringify(result);
    });
  </script>
</body>
</html>`;

    await page.setContent(html);
    await page.waitForFunction(
      () => document.getElementById('result').textContent !== '',
      { timeout: 5000 },
    );

    const resultText = await page.locator('#result').textContent();
    const result = JSON.parse(resultText);
    expect(result.hasClerk).toBe(true);
    expect(result.hasLoad).toBe(true);
    expect(result.hasMountSignIn).toBe(true);
    expect(result.hasMountSignUp).toBe(true);
    expect(result.sessionIsNull).toBe(true);
    expect(result.userIsNull).toBe(true);
  });

  test('WebView2 postMessage integration pattern', async ({ page }) => {
    // Same pattern as the real test — validate that the JS→.NET postMessage
    // bridge works correctly with the expected message shapes
    const messages = [];

    page.on('console', (msg) => {
      if (msg.text().startsWith('WEBVIEW_MSG:')) {
        messages.push(JSON.parse(msg.text().substring('WEBVIEW_MSG:'.length)));
      }
    });

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body>
<script>
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

  simulateSignInComplete();
  simulateSignInCancelled();
  simulateSignInError();
</script>
</body>
</html>`;

    await page.setContent(html);
    await page.waitForTimeout(500);

    expect(messages.length).toBe(3);

    const complete = messages.find((m) => m.type === 'signInComplete');
    expect(complete).toBeTruthy();
    expect(complete.sessionToken).toBe('test-jwt-token-abc123');
    expect(complete.sessionId).toBe('sess_test_123');
    expect(complete.userId).toBe('user_test_456');
    expect(complete.email).toBe('test@example.com');
    expect(complete.name).toBe('Test User');
    expect(complete.expiry).toBeGreaterThan(0);

    const cancelled = messages.find((m) => m.type === 'signInCancelled');
    expect(cancelled).toBeTruthy();

    const error = messages.find((m) => m.type === 'signInError');
    expect(error).toBeTruthy();
    expect(error.message).toBe('Test error');
  });
});

// ─── End-to-end: sign-in flow produces valid Backend API data ─────────────────

test.describe('Full E2E Sign-In → Backend API Validation (mock)', () => {

  test('frontend sign-in creates a real session visible via backend API', async ({ page }) => {
    // 1. Sign in through the UI
    await page.goto(`${BASE_URL}/sign-in`);
    await page.locator('input[name="identifier"]').fill(TEST_EMAIL);
    await page.locator('button[type="submit"]').click();

    const codeInput = page.locator('input[name="code"]');
    await expect(codeInput).toBeVisible({ timeout: 5000 });
    await codeInput.fill(VERIFICATION_CODE);
    await page.locator('#verify-btn').click();

    const result = page.locator('#result');
    await expect(result).toBeVisible({ timeout: 5000 });
    const signInResult = JSON.parse(await result.textContent());
    expect(signInResult.status).toBe('complete');

    // 2. Use the Backend API to verify the session created by the frontend
    const verifyResp = await fetch(`${BASE_URL}/v1/sessions/${signInResult.session_id}/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: signInResult.session_token }),
    });
    expect(verifyResp.status).toBe(200);
    const sessionData = await verifyResp.json();
    expect(sessionData.status).toBe('active');
    expect(sessionData.user_id).toBe(signInResult.user_id);

    // 3. Fetch user info from Backend API
    const userResp = await fetch(`${BASE_URL}/v1/users/${signInResult.user_id}`, {
      headers: { 'Authorization': `Bearer ${SECRET_KEY}` },
    });
    expect(userResp.status).toBe(200);
    const userData = await userResp.json();
    expect(userData.email_addresses[0].email_address).toBe(TEST_EMAIL);
  });
});
