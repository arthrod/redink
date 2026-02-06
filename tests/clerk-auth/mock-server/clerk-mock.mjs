/**
 * Mock Clerk server — emulates both the Backend API and the Frontend sign-in pages.
 *
 * Backend API (default port 9099):
 *   - GET  /v1/users               — list / search users
 *   - POST /v1/users               — create user
 *   - GET  /v1/users/:id           — get user
 *   - DELETE /v1/users/:id         — delete user
 *   - POST /v1/sessions            — create session
 *   - POST /v1/sessions/:id/tokens — create session JWT
 *   - POST /v1/sessions/:id/verify — verify session
 *   - POST /v1/sessions/:id/revoke — revoke session
 *   - POST /v1/testing_tokens      — create testing token
 *   - GET  /.well-known/jwks.json  — JWKS endpoint
 *
 * Frontend (same port):
 *   - GET  /sign-in                — sign-in page (HTML)
 *   - GET  /sign-up                — sign-up page (HTML)
 *   - POST /api/sign-in            — handle sign-in form submit (JSON)
 *   - POST /api/verify-code        — handle OTP verification (JSON)
 *   - GET  /clerk.js               — fake Clerk JS SDK stub
 *
 * Usage:
 *   import { startMockClerk, stopMockClerk } from './clerk-mock.mjs';
 *   const { baseUrl, port } = await startMockClerk();    // random port
 *   // ... run tests ...
 *   await stopMockClerk();
 *
 *   // or with a fixed port:
 *   const info = await startMockClerk(9099);
 */

import http from 'node:http';
import crypto from 'node:crypto';

// ─── In-memory state ──────────────────────────────────────────────────────────

const VALID_SECRET_KEYS = new Set();
let users = new Map();      // id -> user object
let sessions = new Map();   // id -> session object
let testingTokens = [];
let server = null;

const TEST_VERIFICATION_CODE = '424242';

// ─── ID generators ────────────────────────────────────────────────────────────

const uid = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(data || null); }
    });
  });
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function checkAuth(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || !VALID_SECRET_KEYS.has(token)) {
    json(res, 401, {
      errors: [{ message: 'Invalid authentication token', long_message: 'Invalid authentication token', code: 'authentication_invalid' }],
    });
    return false;
  }
  return true;
}

function makeUserObject({ id, emailAddress, firstName, lastName }) {
  const emailId = uid('idn');
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'user',
    first_name: firstName || null,
    last_name: lastName || null,
    primary_email_address_id: emailId,
    email_addresses: [
      { id: emailId, object: 'email_address', email_address: emailAddress, verification: { status: 'verified', strategy: 'email_code' } },
    ],
    phone_numbers: [],
    created_at: now,
    updated_at: now,
    last_sign_in_at: null,
    profile_image_url: '',
    image_url: '',
    username: null,
    external_accounts: [],
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
  };
}

function makeSessionObject({ id, userId }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'session',
    user_id: userId,
    status: 'active',
    expire_at: now + 86400,
    abandon_at: now + 86400 * 7,
    last_active_at: now,
    created_at: now,
    updated_at: now,
  };
}

function makeJwt(sessionId, userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://mock-clerk.local',
    sub: userId,
    sid: sessionId,
    iat: now,
    exp: now + 3600,
    nbf: now,
  })).toString('base64url');
  // Fake signature (not cryptographically valid but structurally correct)
  const sig = crypto.randomBytes(64).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

// ─── Route matcher ────────────────────────────────────────────────────────────

function matchRoute(method, url) {
  const [path, qs] = url.split('?');
  const params = new URLSearchParams(qs || '');

  // Backend API
  if (method === 'GET'  && path === '/v1/users')               return { handler: listUsers, params };
  if (method === 'POST' && path === '/v1/users')               return { handler: createUser };
  if (method === 'GET'  && /^\/v1\/users\/[^/]+$/.test(path))  return { handler: getUser, id: path.split('/')[3] };
  if (method === 'DELETE' && /^\/v1\/users\/[^/]+$/.test(path)) return { handler: deleteUser, id: path.split('/')[3] };

  if (method === 'POST' && path === '/v1/sessions')             return { handler: createSession };
  if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/tokens$/.test(path))  return { handler: createSessionToken, id: path.split('/')[3] };
  if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/verify$/.test(path))  return { handler: verifySession, id: path.split('/')[3] };
  if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/revoke$/.test(path))  return { handler: revokeSession, id: path.split('/')[3] };

  if (method === 'POST' && path === '/v1/testing_tokens')       return { handler: createTestingToken };
  if (method === 'GET'  && path === '/.well-known/jwks.json')   return { handler: getJwks };

  // Frontend pages
  if (method === 'GET' && path === '/sign-in')   return { handler: signInPage };
  if (method === 'GET' && path === '/sign-up')   return { handler: signUpPage };
  if (method === 'POST' && path === '/api/sign-in')      return { handler: apiSignIn };
  if (method === 'POST' && path === '/api/verify-code')  return { handler: apiVerifyCode };
  if (method === 'GET'  && path === '/clerk.js')          return { handler: clerkJsStub };

  return null;
}

// ─── Backend API handlers ─────────────────────────────────────────────────────

async function listUsers(req, res, { params }) {
  if (!checkAuth(req, res)) return;
  const emailFilter = params?.get('email_address');
  const limit = parseInt(params?.get('limit') || '100', 10);
  let result = [...users.values()];
  if (emailFilter) {
    result = result.filter((u) =>
      u.email_addresses.some((ea) => ea.email_address === emailFilter)
    );
  }
  json(res, 200, result.slice(0, limit));
}

async function createUser(req, res) {
  if (!checkAuth(req, res)) return;
  const body = await readBody(req);
  const emailArray = body.email_address || [];
  const emailAddress = Array.isArray(emailArray) ? emailArray[0] : emailArray;

  // Check for duplicates
  for (const u of users.values()) {
    if (u.email_addresses.some((ea) => ea.email_address === emailAddress)) {
      json(res, 422, {
        errors: [{ message: 'That email address is taken. Please try another.', code: 'form_identifier_exists' }],
      });
      return;
    }
  }

  const id = uid('user');
  const user = makeUserObject({
    id,
    emailAddress,
    firstName: body.first_name || null,
    lastName: body.last_name || null,
  });
  users.set(id, user);
  json(res, 200, user);
}

async function getUser(req, res, { id }) {
  if (!checkAuth(req, res)) return;
  const user = users.get(id);
  if (!user) {
    json(res, 404, { errors: [{ message: 'Resource not found', code: 'resource_not_found' }] });
    return;
  }
  json(res, 200, user);
}

async function deleteUser(req, res, { id }) {
  if (!checkAuth(req, res)) return;
  const existed = users.delete(id);
  if (!existed) {
    json(res, 404, { errors: [{ message: 'Resource not found', code: 'resource_not_found' }] });
    return;
  }
  json(res, 200, { id, object: 'user', deleted: true });
}

async function createSession(req, res) {
  if (!checkAuth(req, res)) return;
  const body = await readBody(req);
  const userId = body?.user_id;
  if (!userId || !users.has(userId)) {
    json(res, 404, { errors: [{ message: 'User not found', code: 'resource_not_found' }] });
    return;
  }
  const id = uid('sess');
  const session = makeSessionObject({ id, userId });
  sessions.set(id, session);
  json(res, 200, session);
}

async function createSessionToken(req, res, { id }) {
  if (!checkAuth(req, res)) return;
  const session = sessions.get(id);
  if (!session) {
    json(res, 404, { errors: [{ message: 'Session not found', code: 'resource_not_found' }] });
    return;
  }
  const jwt = makeJwt(id, session.user_id);
  // Store the latest token so verify can use it
  session._latestToken = jwt;
  json(res, 200, { object: 'token', jwt });
}

async function verifySession(req, res, { id }) {
  if (!checkAuth(req, res)) return;
  const session = sessions.get(id);
  if (!session) {
    json(res, 404, { errors: [{ message: 'Session not found', code: 'resource_not_found' }] });
    return;
  }
  if (session.status !== 'active') {
    json(res, 410, { errors: [{ message: 'Session has been revoked', code: 'session_revoked' }] });
    return;
  }
  const body = await readBody(req);
  // In a real server we'd verify the JWT cryptographically; here we just check it exists
  if (!body?.token) {
    json(res, 422, { errors: [{ message: 'Token is required', code: 'form_param_missing' }] });
    return;
  }
  // Update last_active_at
  session.last_active_at = Math.floor(Date.now() / 1000);
  json(res, 200, session);
}

async function revokeSession(req, res, { id }) {
  if (!checkAuth(req, res)) return;
  const session = sessions.get(id);
  if (!session) {
    json(res, 404, { errors: [{ message: 'Session not found', code: 'resource_not_found' }] });
    return;
  }
  session.status = 'revoked';
  json(res, 200, session);
}

async function createTestingToken(req, res) {
  if (!checkAuth(req, res)) return;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  testingTokens.push({ token, expires_at: expiresAt });
  json(res, 200, { object: 'testing_token', token, expires_at: expiresAt });
}

async function getJwks(_req, res) {
  // Return a realistic JWKS with a single RSA key stub
  json(res, 200, {
    keys: [
      {
        use: 'sig',
        kty: 'RSA',
        kid: uid('ins'),
        alg: 'RS256',
        n: 'r2p2FKpE6OQf1rUZ-GflnQ6vX84Fw2e-4DpBc1cghCSvD1FEAP-GnE4CAlMjB_0hzP4TjW8GPoC-u1tJ4QfYEA',
        e: 'AQAB',
      },
    ],
  });
}

// ─── Frontend handlers ────────────────────────────────────────────────────────

const SIGN_IN_HTML = (baseUrl) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in — Mock Clerk</title></head>
<body>
  <h1>Sign in</h1>
  <form id="sign-in-form" data-testid="sign-in-form">
    <label for="identifier">Email address</label>
    <input type="email" id="identifier" name="identifier" placeholder="Enter your email" required />
    <button type="submit">Continue</button>
  </form>
  <div id="verification" style="display:none" data-testid="verification-form">
    <label for="code">Verification code</label>
    <input type="text" id="code" name="code" maxlength="6" required />
    <button id="verify-btn" type="button">Verify</button>
  </div>
  <div id="result" data-testid="result" style="display:none"></div>
  <p>Don't have an account? <a href="/sign-up">Sign up</a></p>
  <script>
    const form = document.getElementById('sign-in-form');
    const verification = document.getElementById('verification');
    const resultDiv = document.getElementById('result');
    let currentEmail = '';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      currentEmail = document.getElementById('identifier').value;
      const resp = await fetch('${baseUrl}/api/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentEmail }),
      });
      const data = await resp.json();
      if (data.status === 'needs_verification') {
        form.style.display = 'none';
        verification.style.display = 'block';
      } else {
        resultDiv.textContent = JSON.stringify(data);
        resultDiv.style.display = 'block';
      }
    });

    document.getElementById('verify-btn').addEventListener('click', async () => {
      const code = document.getElementById('code').value;
      const resp = await fetch('${baseUrl}/api/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentEmail, code }),
      });
      const data = await resp.json();
      verification.style.display = 'none';
      resultDiv.style.display = 'block';
      resultDiv.dataset.status = data.status;
      resultDiv.textContent = JSON.stringify(data);

      // Simulate WebView2 postMessage pattern
      if (data.status === 'complete' && window.chrome?.webview?.postMessage) {
        window.chrome.webview.postMessage(JSON.stringify({
          type: 'signInComplete',
          sessionToken: data.session_token,
          sessionId: data.session_id,
          userId: data.user_id,
          email: currentEmail,
          name: data.user_name || '',
          expiry: data.expiry,
        }));
      }
    });
  </script>
</body>
</html>`;

const SIGN_UP_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign up — Mock Clerk</title></head>
<body>
  <h1>Create your account</h1>
  <form id="sign-up-form" data-testid="sign-up-form">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" required />
    <label for="first_name">First name</label>
    <input type="text" id="first_name" name="first_name" />
    <label for="last_name">Last name</label>
    <input type="text" id="last_name" name="last_name" />
    <button type="submit">Sign up</button>
  </form>
  <p>Already have an account? <a href="/sign-in">Sign in</a></p>
</body>
</html>`;

async function signInPage(_req, res, ctx) {
  html(res, 200, SIGN_IN_HTML(ctx?.baseUrl || ''));
}

async function signUpPage(_req, res) {
  html(res, 200, SIGN_UP_HTML);
}

async function apiSignIn(req, res) {
  const body = await readBody(req);
  const email = body?.email || '';
  // Always require verification (mirrors real Clerk behavior)
  json(res, 200, { status: 'needs_verification', email });
}

async function apiVerifyCode(req, res) {
  const body = await readBody(req);
  const email = body?.email || '';
  const code = body?.code || '';

  // Clerk test mode: emails containing +clerk_test use code 424242
  const isTestEmail = email.includes('+clerk_test');
  if (isTestEmail && code === TEST_VERIFICATION_CODE) {
    // Find or create user
    let user = null;
    for (const u of users.values()) {
      if (u.email_addresses.some((ea) => ea.email_address === email)) {
        user = u;
        break;
      }
    }
    if (!user) {
      const id = uid('user');
      user = makeUserObject({ id, emailAddress: email, firstName: null, lastName: null });
      users.set(id, user);
    }

    // Create session
    const sessId = uid('sess');
    const session = makeSessionObject({ id: sessId, userId: user.id });
    sessions.set(sessId, session);
    const jwt = makeJwt(sessId, user.id);
    session._latestToken = jwt;

    json(res, 200, {
      status: 'complete',
      session_id: sessId,
      session_token: jwt,
      user_id: user.id,
      user_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || '',
      expiry: session.expire_at,
    });
    return;
  }

  // Non-test or wrong code → reject
  json(res, 422, {
    status: 'failed',
    errors: [{ message: 'Incorrect code', code: 'form_code_incorrect' }],
  });
}

async function clerkJsStub(_req, res) {
  // Minimal stub that makes window.Clerk available so the SDK-init test can pass
  const js = `
(function() {
  window.Clerk = {
    load: function() { return Promise.resolve(); },
    mountSignIn: function(el) {
      el.innerHTML = '<div data-testid="clerk-signin-mounted">Sign-in component mounted</div>';
    },
    mountSignUp: function(el) {
      el.innerHTML = '<div data-testid="clerk-signup-mounted">Sign-up component mounted</div>';
    },
    session: null,
    user: null,
  };
  // Dispatch a custom event so tests can detect it
  window.dispatchEvent(new Event('clerk-loaded'));
})();
`;
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': Buffer.byteLength(js),
  });
  res.end(js);
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export async function startMockClerk(port = 0, secretKey = 'sk_test_mock_key') {
  // Reset state
  users = new Map();
  sessions = new Map();
  testingTokens = [];
  VALID_SECRET_KEYS.clear();
  VALID_SECRET_KEYS.add(secretKey);

  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const route = matchRoute(req.method, req.url);
      if (!route) {
        json(res, 404, { errors: [{ message: 'Not found', code: 'route_not_found' }] });
        return;
      }
      try {
        const actualPort = server.address().port;
        const baseUrl = `http://127.0.0.1:${actualPort}`;
        await route.handler(req, res, { ...route, baseUrl });
      } catch (err) {
        json(res, 500, { errors: [{ message: err.message, code: 'internal_error' }] });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ baseUrl, port: addr.port, secretKey });
    });

    server.on('error', reject);
  });
}

export async function stopMockClerk() {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

// Allow registering extra secret keys (e.g. for multi-key tests)
export function registerSecretKey(key) {
  VALID_SECRET_KEYS.add(key);
}

// Reset in-memory data without restarting
export function resetState() {
  users.clear();
  sessions.clear();
  testingTokens = [];
}

// ─── Standalone mode ──────────────────────────────────────────────────────────

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('clerk-mock.mjs') ||
  process.argv[1].endsWith('clerk-mock')
);

if (isMainModule) {
  const port = parseInt(process.env.MOCK_CLERK_PORT || '9099', 10);
  const sk = process.env.MOCK_CLERK_SECRET || 'sk_test_mock_key';
  startMockClerk(port, sk).then(({ baseUrl }) => {
    console.log(`Mock Clerk server running at ${baseUrl}`);
    console.log(`Secret key: ${sk}`);
    console.log('Press Ctrl-C to stop.');
  });
}
