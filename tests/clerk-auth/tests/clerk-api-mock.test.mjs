/**
 * Clerk Backend API integration tests — against the local mock server.
 *
 * These tests are the offline equivalent of clerk-api.test.mjs: they exercise
 * the same Clerk Backend API endpoints and validate the exact response contracts
 * that the VB.NET ClerkApiClient depends on, but without needing network access.
 *
 * Run: node --test tests/clerk-api-mock.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockClerk, stopMockClerk, resetState } from '../mock-server/clerk-mock.mjs';

let BASE_URL;
let SECRET_KEY;
const TEST_EMAIL = 'redink_test+clerk_test@example.com';
const SCHEMA_TEST_EMAIL = 'redink_schema_test+clerk_test@example.com';

// ─── HTTP helper (mirrors the one in clerk-api.test.mjs but uses http) ──────

async function clerkApi(method, path, body = null) {
  const url = new URL(path, BASE_URL);
  return new Promise((resolve, reject) => {
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    const req = http.request(options, (res) => {
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

// ─── Server lifecycle ─────────────────────────────────────────────────────────

before(async () => {
  const info = await startMockClerk(0, 'sk_test_mock_integration');
  BASE_URL = info.baseUrl;
  SECRET_KEY = info.secretKey;
});

after(async () => {
  await stopMockClerk();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

let testUserId = null;
let testSessionId = null;
let testSessionToken = null;

describe('Clerk Backend API Integration (mock)', () => {

  describe('Connection & Authentication', () => {
    it('authenticates with secret key and lists users', async () => {
      const { status, data } = await clerkApi('GET', '/v1/users?limit=1');
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
      assert.ok(Array.isArray(data), 'Should return array of users');
    });

    it('rejects invalid secret key', async () => {
      const url = new URL('/v1/users?limit=1', BASE_URL);
      const { status } = await new Promise((resolve, reject) => {
        const req = http.request({
          method: 'GET',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            'Authorization': 'Bearer sk_test_invalid_key_12345',
            'Accept': 'application/json',
          },
        }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.ok([401, 403].includes(status), `Expected 401/403, got ${status}`);
    });

    it('returns 401 with no auth header at all', async () => {
      const url = new URL('/v1/users', BASE_URL);
      const { status } = await new Promise((resolve, reject) => {
        const req = http.request({
          method: 'GET',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { 'Accept': 'application/json' },
        }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 401);
    });
  });

  describe('User Lifecycle', () => {
    it('creates a test user with +clerk_test email', async () => {
      const { status, data } = await clerkApi('POST', '/v1/users', {
        email_address: [TEST_EMAIL],
        skip_password_requirement: true,
      });
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
      testUserId = data.id;
      assert.ok(testUserId.startsWith('user_'), `User ID should start with user_, got: ${testUserId}`);
      assert.equal(data.email_addresses[0].email_address, TEST_EMAIL);
    });

    it('rejects duplicate email', async () => {
      const { status, data } = await clerkApi('POST', '/v1/users', {
        email_address: [TEST_EMAIL],
      });
      assert.equal(status, 422, `Expected 422 for duplicate, got ${status}`);
      assert.ok(data.errors, 'Should have errors array');
      assert.equal(data.errors[0].code, 'form_identifier_exists');
    });

    it('retrieves user by ID', async () => {
      assert.ok(testUserId, 'Test user must exist');
      const { status, data } = await clerkApi('GET', `/v1/users/${testUserId}`);
      assert.equal(status, 200);
      assert.equal(data.id, testUserId);
      assert.ok(data.email_addresses, 'Should have email_addresses array');
      assert.ok(data.hasOwnProperty('first_name'), 'Should have first_name');
      assert.ok(data.hasOwnProperty('last_name'), 'Should have last_name');
      assert.ok(data.hasOwnProperty('primary_email_address_id'), 'Should have primary_email_address_id');
      assert.ok(data.hasOwnProperty('created_at'), 'Should have created_at');
      assert.ok(data.hasOwnProperty('updated_at'), 'Should have updated_at');
    });

    it('returns 404 for non-existent user', async () => {
      const { status } = await clerkApi('GET', '/v1/users/user_does_not_exist');
      assert.equal(status, 404);
    });

    it('searches users by email', async () => {
      const { status, data } = await clerkApi('GET', `/v1/users?email_address=${encodeURIComponent(TEST_EMAIL)}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 1);
      assert.equal(data[0].id, testUserId);
    });
  });

  describe('Session Management', () => {
    it('creates a session for the test user', async () => {
      assert.ok(testUserId, 'Test user must exist');
      const { status, data } = await clerkApi('POST', '/v1/sessions', {
        user_id: testUserId,
      });
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
      testSessionId = data.id;
      assert.ok(testSessionId.startsWith('sess_'), `Session ID should start with sess_, got: ${testSessionId}`);
      assert.equal(data.user_id, testUserId);
      assert.equal(data.status, 'active');
      assert.ok(data.expire_at, 'Should have expire_at');
      assert.ok(data.last_active_at, 'Should have last_active_at');
    });

    it('rejects session for non-existent user', async () => {
      const { status } = await clerkApi('POST', '/v1/sessions', {
        user_id: 'user_ghost',
      });
      assert.equal(status, 404);
    });

    it('creates a session token (JWT)', async () => {
      assert.ok(testSessionId, 'Test session must exist');
      const { status, data } = await clerkApi('POST', `/v1/sessions/${testSessionId}/tokens`);
      assert.equal(status, 200, `Expected 200, got ${status}`);
      testSessionToken = data.jwt;
      assert.ok(testSessionToken, 'Should return a JWT');
      assert.equal(testSessionToken.split('.').length, 3, 'JWT should have 3 parts');
    });

    it('JWT payload contains expected claims', () => {
      assert.ok(testSessionToken, 'JWT must exist');
      const payloadB64 = testSessionToken.split('.')[1];
      // base64url → base64
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      assert.equal(payload.sub, testUserId);
      assert.equal(payload.sid, testSessionId);
      assert.ok(payload.iat, 'Should have iat');
      assert.ok(payload.exp, 'Should have exp');
      assert.ok(payload.exp > payload.iat, 'exp should be after iat');
    });

    it('verifies the session', async () => {
      assert.ok(testSessionId && testSessionToken, 'Session and token must exist');
      const { status, data } = await clerkApi('POST', `/v1/sessions/${testSessionId}/verify`, {
        token: testSessionToken,
      });
      assert.equal(status, 200);
      assert.equal(data.id, testSessionId);
      assert.equal(data.status, 'active');
      assert.equal(data.user_id, testUserId);
    });

    it('verify rejects missing token', async () => {
      assert.ok(testSessionId, 'Session must exist');
      const { status } = await clerkApi('POST', `/v1/sessions/${testSessionId}/verify`, {});
      assert.equal(status, 422);
    });

    it('revokes the session', async () => {
      assert.ok(testSessionId, 'Session must exist');
      const { status, data } = await clerkApi('POST', `/v1/sessions/${testSessionId}/revoke`);
      assert.equal(status, 200);
      assert.equal(data.status, 'revoked');
    });

    it('verify fails on revoked session', async () => {
      assert.ok(testSessionId && testSessionToken, 'Session and token must exist');
      const { status } = await clerkApi('POST', `/v1/sessions/${testSessionId}/verify`, {
        token: testSessionToken,
      });
      assert.equal(status, 410, 'Revoked session verify should return 410');
    });

    it('returns 404 for tokens on non-existent session', async () => {
      const { status } = await clerkApi('POST', '/v1/sessions/sess_nonexistent/tokens');
      assert.equal(status, 404);
    });
  });

  describe('JWKS Endpoint', () => {
    it('fetches JWKS (no auth required)', async () => {
      const url = new URL('/.well-known/jwks.json', BASE_URL);
      const { status, data } = await new Promise((resolve, reject) => {
        http.get(url, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
            catch { resolve({ status: res.statusCode, data: d }); }
          });
        }).on('error', reject);
      });
      assert.equal(status, 200);
      assert.ok(data.keys, 'JWKS should have keys array');
      assert.ok(data.keys.length > 0, 'Should have at least one key');
      assert.ok(data.keys[0].kty, 'Key should have kty');
      assert.equal(data.keys[0].alg, 'RS256');
      assert.equal(data.keys[0].use, 'sig');
    });
  });

  describe('Testing Token', () => {
    it('creates a testing token for the instance', async () => {
      const { status, data } = await clerkApi('POST', '/v1/testing_tokens');
      assert.equal(status, 200);
      assert.ok(data.token, 'Should return a testing token');
      assert.ok(data.expires_at, 'Should have expires_at');
      assert.ok(data.expires_at > Math.floor(Date.now() / 1000), 'Token should not be expired yet');
    });
  });

  describe('Cleanup', () => {
    it('deletes the test user', async () => {
      assert.ok(testUserId, 'Test user must exist');
      const { status, data } = await clerkApi('DELETE', `/v1/users/${testUserId}`);
      assert.equal(status, 200);
      assert.equal(data.deleted, true);
    });

    it('user is gone after deletion', async () => {
      assert.ok(testUserId, 'Test user ID must be set');
      const { status } = await clerkApi('GET', `/v1/users/${testUserId}`);
      assert.equal(status, 404);
    });
  });
});

describe('Clerk API Response Contract Validation (mock)', () => {
  it('user response matches expected schema', async () => {
    const { status, data } = await clerkApi('POST', '/v1/users', {
      email_address: [SCHEMA_TEST_EMAIL],
      first_name: 'Schema',
      last_name: 'Test',
      skip_password_requirement: true,
    });

    let userId = null;
    try {
      assert.equal(status, 200);
      userId = data.id;

      const { data: user } = await clerkApi('GET', `/v1/users/${userId}`);

      // Validate all fields our VB.NET ParseUserInfo depends on
      assert.equal(typeof user.id, 'string');
      assert.ok(user.id.startsWith('user_'));
      assert.ok(user.hasOwnProperty('first_name'));
      assert.ok(user.hasOwnProperty('last_name'));
      assert.ok(user.hasOwnProperty('primary_email_address_id'));
      assert.ok(Array.isArray(user.email_addresses));
      assert.ok(user.hasOwnProperty('created_at'));
      assert.ok(user.hasOwnProperty('updated_at'));

      // Validate name values
      assert.equal(user.first_name, 'Schema');
      assert.equal(user.last_name, 'Test');

      // Validate email address sub-object
      assert.ok(user.email_addresses.length > 0, 'Should have at least one email');
      const ea = user.email_addresses[0];
      assert.ok(ea.hasOwnProperty('id'));
      assert.ok(ea.hasOwnProperty('email_address'));
      assert.equal(ea.email_address, SCHEMA_TEST_EMAIL);

      // Validate additional fields for completeness
      assert.ok(user.hasOwnProperty('phone_numbers'));
      assert.ok(user.hasOwnProperty('public_metadata'));
      assert.ok(user.hasOwnProperty('private_metadata'));
    } finally {
      if (userId) {
        await clerkApi('DELETE', `/v1/users/${userId}`);
      }
    }
  });

  it('session response matches expected schema', async () => {
    // Create a user first
    const { data: userData } = await clerkApi('POST', '/v1/users', {
      email_address: ['schema_session+clerk_test@example.com'],
    });
    const userId = userData.id;

    try {
      const { status, data: session } = await clerkApi('POST', '/v1/sessions', {
        user_id: userId,
      });
      assert.equal(status, 200);

      // Validate session schema that our VB.NET ParseSessionInfo depends on
      assert.equal(typeof session.id, 'string');
      assert.ok(session.id.startsWith('sess_'));
      assert.equal(session.object, 'session');
      assert.equal(session.user_id, userId);
      assert.equal(session.status, 'active');
      assert.equal(typeof session.expire_at, 'number');
      assert.equal(typeof session.last_active_at, 'number');
      assert.equal(typeof session.created_at, 'number');
    } finally {
      await clerkApi('DELETE', `/v1/users/${userId}`);
    }
  });

  it('token response matches expected schema', async () => {
    const { data: userData } = await clerkApi('POST', '/v1/users', {
      email_address: ['schema_token+clerk_test@example.com'],
    });
    const userId = userData.id;

    try {
      const { data: sessData } = await clerkApi('POST', '/v1/sessions', { user_id: userId });
      const sessId = sessData.id;

      const { status, data } = await clerkApi('POST', `/v1/sessions/${sessId}/tokens`);
      assert.equal(status, 200);
      assert.equal(data.object, 'token');
      assert.equal(typeof data.jwt, 'string');
      assert.equal(data.jwt.split('.').length, 3, 'JWT must have 3 parts');
    } finally {
      await clerkApi('DELETE', `/v1/users/${userId}`);
    }
  });

  it('error response matches expected schema', async () => {
    const { status, data } = await clerkApi('GET', '/v1/users/user_does_not_exist_at_all');
    assert.equal(status, 404);
    assert.ok(data.errors, 'Error response should have errors array');
    assert.ok(data.errors.length > 0);
    assert.ok(data.errors[0].message, 'Error should have message');
    assert.ok(data.errors[0].code, 'Error should have code');
  });
});

describe('Full Sign-In Flow via API (mock)', () => {
  it('sign-in → verify → session → token → verify-session → sign-out lifecycle', async () => {
    // 1. Create user
    const email = 'lifecycle_test+clerk_test@example.com';
    const { data: user } = await clerkApi('POST', '/v1/users', {
      email_address: [email],
      first_name: 'Lifecycle',
      last_name: 'User',
    });
    assert.ok(user.id);

    // 2. Create session
    const { data: sess } = await clerkApi('POST', '/v1/sessions', { user_id: user.id });
    assert.equal(sess.status, 'active');

    // 3. Get token
    const { data: tok } = await clerkApi('POST', `/v1/sessions/${sess.id}/tokens`);
    assert.ok(tok.jwt);

    // 4. Verify session
    const { data: verified } = await clerkApi('POST', `/v1/sessions/${sess.id}/verify`, { token: tok.jwt });
    assert.equal(verified.status, 'active');
    assert.equal(verified.user_id, user.id);

    // 5. Get user info (as ClerkAuthManager.SignInAsync does)
    const { data: userInfo } = await clerkApi('GET', `/v1/users/${user.id}`);
    assert.equal(userInfo.first_name, 'Lifecycle');
    assert.equal(userInfo.last_name, 'User');
    assert.equal(userInfo.email_addresses[0].email_address, email);

    // 6. Revoke session (sign-out)
    const { data: revoked } = await clerkApi('POST', `/v1/sessions/${sess.id}/revoke`);
    assert.equal(revoked.status, 'revoked');

    // 7. Verify fails after revocation
    const { status: verifyStatus } = await clerkApi('POST', `/v1/sessions/${sess.id}/verify`, { token: tok.jwt });
    assert.equal(verifyStatus, 410);

    // 8. Cleanup
    await clerkApi('DELETE', `/v1/users/${user.id}`);
  });
});
