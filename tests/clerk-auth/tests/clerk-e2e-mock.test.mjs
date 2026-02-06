/**
 * End-to-end sign-in flow tests — against the local mock server (Node.js HTTP).
 *
 * These tests exercise the same frontend endpoints and sign-in flow as the
 * Playwright E2E tests, but via Node.js HTTP requests — no browser required.
 * They validate:
 *   - Sign-in and sign-up page HTML structure
 *   - Email submission → verification flow
 *   - Test email (+clerk_test) with code 424242
 *   - Wrong code rejection
 *   - Non-test email rejection
 *   - Clerk.js SDK stub
 *   - Full frontend → backend API round-trip
 *   - WebView2 postMessage message shapes
 *
 * Run: node --test tests/clerk-e2e-mock.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockClerk, stopMockClerk } from '../mock-server/clerk-mock.mjs';

let BASE_URL;
let SECRET_KEY;
const TEST_EMAIL = 'redink_e2e+clerk_test@example.com';
const VERIFICATION_CODE = '424242';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpGet(path) {
  const url = new URL(path, BASE_URL);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

async function httpPost(path, body) {
  const url = new URL(path, BASE_URL);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function clerkApi(method, path, body = null) {
  const url = new URL(path, BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  const info = await startMockClerk(0, 'sk_test_e2e_node');
  BASE_URL = info.baseUrl;
  SECRET_KEY = info.secretKey;
});

after(async () => {
  await stopMockClerk();
});

// ─── Sign-In Page HTML ───────────────────────────────────────────────────────

describe('Sign-In Page HTML (mock)', () => {
  it('serves the sign-in page with correct structure', async () => {
    const { status, body, headers } = await httpGet('/sign-in');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/html'));

    // Must have the essential UI elements
    assert.ok(body.includes('<h1>Sign in</h1>'), 'Should have Sign in heading');
    assert.ok(body.includes('name="identifier"'), 'Should have identifier input');
    assert.ok(body.includes('type="email"'), 'Input should be email type');
    assert.ok(body.includes('Continue'), 'Should have Continue button');
    assert.ok(body.includes('name="code"'), 'Should have verification code input');
    assert.ok(body.includes('id="verify-btn"'), 'Should have verify button');
    assert.ok(body.includes('id="result"'), 'Should have result div');
    assert.ok(body.includes('/sign-up'), 'Should link to sign-up page');
  });

  it('sign-in page includes API fetch for verification flow', async () => {
    const { body } = await httpGet('/sign-in');
    // The sign-in page JS should POST to /api/sign-in and /api/verify-code
    assert.ok(body.includes('/api/sign-in'), 'Should reference /api/sign-in endpoint');
    assert.ok(body.includes('/api/verify-code'), 'Should reference /api/verify-code endpoint');
  });

  it('sign-in page includes WebView2 postMessage pattern', async () => {
    const { body } = await httpGet('/sign-in');
    // The sign-in HTML should include the postMessage pattern for WebView2
    assert.ok(body.includes('chrome.webview') || body.includes('postMessage'),
      'Should include WebView2 postMessage integration');
  });
});

// ─── Sign-Up Page HTML ───────────────────────────────────────────────────────

describe('Sign-Up Page HTML (mock)', () => {
  it('serves the sign-up page with correct structure', async () => {
    const { status, body, headers } = await httpGet('/sign-up');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/html'));

    assert.ok(body.includes('Create your account'), 'Should have sign-up heading');
    assert.ok(body.includes('name="email"'), 'Should have email input');
    assert.ok(body.includes('name="first_name"'), 'Should have first name input');
    assert.ok(body.includes('name="last_name"'), 'Should have last name input');
    assert.ok(body.includes('Sign up'), 'Should have Sign up button');
    assert.ok(body.includes('/sign-in'), 'Should link to sign-in page');
  });
});

// ─── Sign-In API Flow ─────────────────────────────────────────────────────────

describe('Sign-In API Flow (mock)', () => {
  it('email submission returns needs_verification', async () => {
    const { status, data } = await httpPost('/api/sign-in', { email: TEST_EMAIL });
    assert.equal(status, 200);
    assert.equal(data.status, 'needs_verification');
    assert.equal(data.email, TEST_EMAIL);
  });

  it('correct verification code (424242) for +clerk_test email → complete', async () => {
    const { status, data } = await httpPost('/api/verify-code', {
      email: TEST_EMAIL,
      code: VERIFICATION_CODE,
    });
    assert.equal(status, 200);
    assert.equal(data.status, 'complete');
    assert.ok(data.session_id.startsWith('sess_'), 'Should return session ID');
    assert.ok(data.user_id.startsWith('user_'), 'Should return user ID');
    assert.ok(data.session_token, 'Should return session token');
    assert.equal(data.session_token.split('.').length, 3, 'Token should be JWT format');
    assert.ok(data.expiry > Math.floor(Date.now() / 1000), 'Expiry should be in the future');
  });

  it('wrong verification code → failed', async () => {
    const { status, data } = await httpPost('/api/verify-code', {
      email: TEST_EMAIL,
      code: '000000',
    });
    assert.equal(status, 422);
    assert.equal(data.status, 'failed');
    assert.ok(data.errors, 'Should have errors array');
    assert.equal(data.errors[0].code, 'form_code_incorrect');
  });

  it('non-test email (no +clerk_test) is rejected even with code 424242', async () => {
    const { status, data } = await httpPost('/api/verify-code', {
      email: 'regular@example.com',
      code: VERIFICATION_CODE,
    });
    assert.equal(status, 422);
    assert.equal(data.status, 'failed');
  });

  it('empty code → failed', async () => {
    const { status, data } = await httpPost('/api/verify-code', {
      email: TEST_EMAIL,
      code: '',
    });
    assert.equal(status, 422);
    assert.equal(data.status, 'failed');
  });

  it('multiple test emails create separate users', async () => {
    const email1 = 'user_a+clerk_test@example.com';
    const email2 = 'user_b+clerk_test@example.com';

    const r1 = await httpPost('/api/verify-code', { email: email1, code: VERIFICATION_CODE });
    const r2 = await httpPost('/api/verify-code', { email: email2, code: VERIFICATION_CODE });

    assert.equal(r1.data.status, 'complete');
    assert.equal(r2.data.status, 'complete');
    assert.notEqual(r1.data.user_id, r2.data.user_id, 'Different emails should create different users');
    assert.notEqual(r1.data.session_id, r2.data.session_id, 'Should get different sessions');
  });

  it('same test email reuses existing user', async () => {
    const email = 'reuse+clerk_test@example.com';

    const r1 = await httpPost('/api/verify-code', { email, code: VERIFICATION_CODE });
    const r2 = await httpPost('/api/verify-code', { email, code: VERIFICATION_CODE });

    assert.equal(r1.data.user_id, r2.data.user_id, 'Same email should reuse user');
    assert.notEqual(r1.data.session_id, r2.data.session_id, 'But should get different sessions');
  });
});

// ─── Clerk.js SDK Stub ───────────────────────────────────────────────────────

describe('Clerk.js SDK Stub (mock)', () => {
  it('serves JavaScript with correct content-type', async () => {
    const { status, headers } = await httpGet('/clerk.js');
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('javascript'));
  });

  it('stub defines window.Clerk with expected API surface', async () => {
    const { body } = await httpGet('/clerk.js');
    assert.ok(body.includes('window.Clerk'), 'Should define window.Clerk');
    assert.ok(body.includes('load'), 'Should have load method');
    assert.ok(body.includes('mountSignIn'), 'Should have mountSignIn method');
    assert.ok(body.includes('mountSignUp'), 'Should have mountSignUp method');
    assert.ok(body.includes('session'), 'Should have session property');
    assert.ok(body.includes('user'), 'Should have user property');
  });

  it('stub dispatches clerk-loaded event', async () => {
    const { body } = await httpGet('/clerk.js');
    assert.ok(body.includes("clerk-loaded"), 'Should dispatch clerk-loaded event');
  });
});

// ─── Full Frontend → Backend Round-Trip ──────────────────────────────────────

describe('Full Frontend → Backend API Round-Trip (mock)', () => {
  it('frontend sign-in creates session verifiable via backend API', async () => {
    const email = 'roundtrip+clerk_test@example.com';

    // 1. Frontend sign-in flow
    const signIn = await httpPost('/api/sign-in', { email });
    assert.equal(signIn.data.status, 'needs_verification');

    const verify = await httpPost('/api/verify-code', { email, code: VERIFICATION_CODE });
    assert.equal(verify.data.status, 'complete');
    const { session_id, session_token, user_id } = verify.data;

    // 2. Backend API: verify the session
    const sessVerify = await clerkApi('POST', `/v1/sessions/${session_id}/verify`, {
      token: session_token,
    });
    assert.equal(sessVerify.status, 200);
    assert.equal(sessVerify.data.status, 'active');
    assert.equal(sessVerify.data.user_id, user_id);

    // 3. Backend API: fetch user info
    const userResp = await clerkApi('GET', `/v1/users/${user_id}`);
    assert.equal(userResp.status, 200);
    assert.equal(userResp.data.email_addresses[0].email_address, email);

    // 4. Backend API: revoke session (sign-out)
    const revoke = await clerkApi('POST', `/v1/sessions/${session_id}/revoke`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.data.status, 'revoked');

    // 5. Verify session is no longer valid
    const reVerify = await clerkApi('POST', `/v1/sessions/${session_id}/verify`, {
      token: session_token,
    });
    assert.equal(reVerify.status, 410, 'Revoked session should return 410');
  });

  it('JWT from frontend contains correct claims', async () => {
    const email = 'jwt_claims+clerk_test@example.com';

    const verify = await httpPost('/api/verify-code', { email, code: VERIFICATION_CODE });
    assert.equal(verify.data.status, 'complete');

    const jwt = verify.data.session_token;
    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT should have 3 parts');

    // Decode header
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.equal(payload.sub, verify.data.user_id);
    assert.equal(payload.sid, verify.data.session_id);
    assert.ok(payload.iat, 'Should have iat');
    assert.ok(payload.exp, 'Should have exp');
    assert.ok(payload.exp > payload.iat, 'exp should be after iat');
  });
});

// ─── WebView2 PostMessage Contract ───────────────────────────────────────────

describe('WebView2 PostMessage Message Shape Validation (mock)', () => {
  it('signInComplete message has all required fields', async () => {
    const email = 'postmsg+clerk_test@example.com';
    const verify = await httpPost('/api/verify-code', { email, code: VERIFICATION_CODE });
    assert.equal(verify.data.status, 'complete');

    // Simulate the WebView2 message that ClerkSignInDialog.vb would construct
    const msg = {
      type: 'signInComplete',
      sessionToken: verify.data.session_token,
      sessionId: verify.data.session_id,
      userId: verify.data.user_id,
      email: email,
      name: verify.data.user_name || '',
      expiry: verify.data.expiry,
    };

    // Validate all fields our VB.NET ClerkSignInDialog expects
    assert.equal(typeof msg.type, 'string');
    assert.equal(msg.type, 'signInComplete');
    assert.equal(typeof msg.sessionToken, 'string');
    assert.ok(msg.sessionToken.length > 0, 'sessionToken must not be empty');
    assert.equal(typeof msg.sessionId, 'string');
    assert.ok(msg.sessionId.startsWith('sess_'));
    assert.equal(typeof msg.userId, 'string');
    assert.ok(msg.userId.startsWith('user_'));
    assert.equal(typeof msg.email, 'string');
    assert.equal(msg.email, email);
    assert.equal(typeof msg.name, 'string');
    assert.equal(typeof msg.expiry, 'number');
    assert.ok(msg.expiry > Math.floor(Date.now() / 1000));
  });

  it('signInCancelled message shape', () => {
    const msg = { type: 'signInCancelled' };
    assert.equal(msg.type, 'signInCancelled');
    // JSON.stringify round-trip (as it would go through postMessage)
    const parsed = JSON.parse(JSON.stringify(msg));
    assert.equal(parsed.type, 'signInCancelled');
  });

  it('signInError message shape', () => {
    const msg = { type: 'signInError', message: 'Something went wrong' };
    assert.equal(msg.type, 'signInError');
    assert.equal(typeof msg.message, 'string');
    const parsed = JSON.parse(JSON.stringify(msg));
    assert.equal(parsed.type, 'signInError');
    assert.equal(parsed.message, 'Something went wrong');
  });
});

// ─── 404 handling ─────────────────────────────────────────────────────────────

describe('Mock Server 404 Handling', () => {
  it('returns 404 for unknown routes', async () => {
    const { status } = await httpGet('/nonexistent');
    assert.equal(status, 404);
  });

  it('returns JSON error for unknown API routes', async () => {
    const resp = await clerkApi('GET', '/v1/nonexistent');
    assert.equal(resp.status, 404);
    assert.ok(resp.data.errors, 'Should have errors');
  });
});
