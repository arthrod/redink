/**
 * Unit tests for Red Ink Clerk authentication components.
 *
 * These tests validate the auth logic independently of network access:
 * - Token encryption/decryption round-trips (simulating DPAPI behavior in Node.js)
 * - Token store lifecycle (save/load/clear/expiry)
 * - Auth manager state transitions
 * - Clerk API client response parsing
 * - Sign-in result and session expiry logic
 * - ClerkUserInfo display name logic
 *
 * Run: node --test tests/unit.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ============================================================================
// Helpers: Port key VB.NET auth logic to JS for testing
// ============================================================================

/** Simulates DPAPI-like encrypt/decrypt for token storage testing. */
class TokenEncryption {
  constructor() {
    // Use AES-256-GCM as a stand-in for DPAPI (CurrentUser scope)
    this._key = crypto.randomBytes(32);
  }

  encrypt(plaintext) {
    if (!plaintext) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    // Pack: iv + authTag + ciphertext
    return Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64');
  }

  decrypt(encryptedBase64) {
    if (!encryptedBase64) return '';
    try {
      const buf = Buffer.from(encryptedBase64, 'base64');
      const iv = buf.subarray(0, 16);
      const authTag = buf.subarray(16, 32);
      const ciphertext = buf.subarray(32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, null, 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return '';
    }
  }
}

/** In-memory token store (mirrors ClerkTokenStore behavior). */
class TokenStore {
  constructor(encryption) {
    this._encryption = encryption;
    this._storage = null;
  }

  saveToken(sessionToken, sessionId, userId, userEmail, userName, tokenExpiry) {
    this._storage = {
      encryptedToken: this._encryption.encrypt(sessionToken),
      userId, userEmail, userName, sessionId, tokenExpiry
    };
  }

  loadToken() {
    if (!this._storage || !this._storage.encryptedToken) return null;
    const token = this._encryption.decrypt(this._storage.encryptedToken);
    if (!token) return null;
    return {
      sessionToken: token,
      sessionId: this._storage.sessionId,
      userId: this._storage.userId,
      userEmail: this._storage.userEmail,
      userName: this._storage.userName,
      tokenExpiry: this._storage.tokenExpiry,
      get isExpired() {
        if (this.tokenExpiry <= 0) return true;
        return this.tokenExpiry <= Math.floor(Date.now() / 1000);
      }
    };
  }

  hasValidToken() {
    if (!this._storage || !this._storage.encryptedToken) return false;
    if (this._storage.tokenExpiry <= 0) return false;
    return this._storage.tokenExpiry > Math.floor(Date.now() / 1000);
  }

  clearToken() {
    this._storage = null;
  }
}

/** Auth context (mirrors ISharedContext auth properties). */
class AuthContext {
  constructor() {
    this.Auth_IsAuthenticated = false;
    this.Auth_UserId = '';
    this.Auth_UserEmail = '';
    this.Auth_UserName = '';
    this.Auth_SessionToken = '';
    this.Auth_TokenExpiry = 0;
    this.INI_ClerkPublishableKey = '';
    this.INI_ClerkSecretKey = '';
    this.INI_ClerkDomain = '';
  }
}

/** Auth manager (mirrors ClerkAuthManager behavior). */
class AuthManager {
  constructor(context, tokenStore) {
    this._context = context;
    this._tokenStore = tokenStore;
  }

  get isAuthenticated() {
    return this._context.Auth_IsAuthenticated;
  }

  get currentUserName() {
    if (this._context.Auth_IsAuthenticated) {
      if (this._context.Auth_UserName) return this._context.Auth_UserName;
      if (this._context.Auth_UserEmail) return this._context.Auth_UserEmail;
    }
    return '';
  }

  initializeFromCache() {
    if (!this._context.INI_ClerkSecretKey) {
      this._clearContextAuth();
      return;
    }
    if (!this._tokenStore.hasValidToken()) {
      this._tokenStore.clearToken();
      this._clearContextAuth();
      return;
    }
    const stored = this._tokenStore.loadToken();
    if (!stored || stored.isExpired) {
      this._tokenStore.clearToken();
      this._clearContextAuth();
      return;
    }
    this._populateContext(stored.sessionToken, stored.userId, stored.userEmail, stored.userName, stored.tokenExpiry);
  }

  simulateSignIn(result) {
    this._tokenStore.saveToken(result.sessionToken, result.sessionId, result.userId, result.userEmail, result.userName, result.tokenExpiry);
    this._populateContext(result.sessionToken, result.userId, result.userEmail, result.userName, result.tokenExpiry);
  }

  signOut() {
    this._tokenStore.clearToken();
    this._clearContextAuth();
  }

  _populateContext(sessionToken, userId, email, displayName, tokenExpiry) {
    this._context.Auth_IsAuthenticated = true;
    this._context.Auth_SessionToken = sessionToken;
    this._context.Auth_UserId = userId || '';
    this._context.Auth_UserEmail = email || '';
    this._context.Auth_UserName = displayName || '';
    this._context.Auth_TokenExpiry = tokenExpiry;
  }

  _clearContextAuth() {
    this._context.Auth_IsAuthenticated = false;
    this._context.Auth_SessionToken = '';
    this._context.Auth_UserId = '';
    this._context.Auth_UserEmail = '';
    this._context.Auth_UserName = '';
    this._context.Auth_TokenExpiry = 0;
  }
}

/** Parses Clerk session verify response (mirrors ClerkApiClient.ParseSessionInfo). */
function parseSessionInfo(json) {
  try {
    const obj = JSON.parse(json);
    if (obj.status !== 'active') return null;
    return {
      sessionId: obj.id,
      userId: obj.user_id,
      status: obj.status,
      expireAt: obj.expire_at,
      lastActiveAt: obj.last_active_at
    };
  } catch {
    return null;
  }
}

/** Parses Clerk user response (mirrors ClerkApiClient.ParseUserInfo). */
function parseUserInfo(json) {
  try {
    const obj = JSON.parse(json);
    const primaryEmailId = obj.primary_email_address_id;
    let primaryEmail = '';
    if (obj.email_addresses && primaryEmailId) {
      for (const ea of obj.email_addresses) {
        if (ea.id === primaryEmailId) {
          primaryEmail = ea.email_address;
          break;
        }
      }
    }
    const firstName = obj.first_name || '';
    const lastName = obj.last_name || '';
    const displayName = `${firstName} ${lastName}`.trim() || primaryEmail;
    return {
      userId: obj.id,
      firstName, lastName,
      email: primaryEmail,
      displayName,
      createdAt: obj.created_at,
      updatedAt: obj.updated_at
    };
  } catch {
    return null;
  }
}

/** Escapes a string for safe JSON embedding (mirrors ClerkApiClient.EscapeJsonString). */
function escapeJsonString(value) {
  if (!value) return '';
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// ============================================================================
// Tests
// ============================================================================

describe('Token Encryption', () => {
  let enc;
  before(() => { enc = new TokenEncryption(); });

  it('round-trips a normal token', () => {
    const original = 'sk_test_abc123_session_token_with_special_chars!@#$%';
    const encrypted = enc.encrypt(original);
    const decrypted = enc.decrypt(encrypted);
    assert.equal(decrypted, original);
  });

  it('encrypted form differs from original', () => {
    const original = 'my-secret-token';
    const encrypted = enc.encrypt(original);
    assert.notEqual(encrypted, original);
  });

  it('handles empty string', () => {
    assert.equal(enc.encrypt(''), '');
    assert.equal(enc.decrypt(''), '');
  });

  it('handles null/undefined', () => {
    assert.equal(enc.encrypt(null), '');
    assert.equal(enc.encrypt(undefined), '');
    assert.equal(enc.decrypt(null), '');
    assert.equal(enc.decrypt(undefined), '');
  });

  it('returns empty on invalid encrypted data', () => {
    assert.equal(enc.decrypt('not-valid-base64!!!'), '');
    assert.equal(enc.decrypt('dGVzdA=='), ''); // valid base64 but not valid encrypted
  });

  it('different encryptions of same plaintext produce different ciphertext', () => {
    const original = 'same-token';
    const e1 = enc.encrypt(original);
    const e2 = enc.encrypt(original);
    assert.notEqual(e1, e2, 'Each encryption should use a different IV');
    assert.equal(enc.decrypt(e1), original);
    assert.equal(enc.decrypt(e2), original);
  });

  it('handles long tokens (JWT-length)', () => {
    const longToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + 'a'.repeat(500) + '.' + 'b'.repeat(300);
    const encrypted = enc.encrypt(longToken);
    const decrypted = enc.decrypt(encrypted);
    assert.equal(decrypted, longToken);
  });

  it('handles unicode characters', () => {
    const unicode = 'token_with_émojis_🔐_and_日本語';
    const encrypted = enc.encrypt(unicode);
    const decrypted = enc.decrypt(encrypted);
    assert.equal(decrypted, unicode);
  });
});

describe('Token Store Lifecycle', () => {
  let enc, store;
  before(() => {
    enc = new TokenEncryption();
    store = new TokenStore(enc);
  });

  it('returns null on initial load', () => {
    assert.equal(store.loadToken(), null);
  });

  it('reports no valid token initially', () => {
    assert.equal(store.hasValidToken(), false);
  });

  it('saves and loads a token with future expiry', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    store.saveToken('test-token-123', 'sess_abc', 'user_xyz', 'test@example.com', 'Test User', futureExpiry);

    assert.equal(store.hasValidToken(), true);
    const loaded = store.loadToken();
    assert.notEqual(loaded, null);
    assert.equal(loaded.sessionToken, 'test-token-123');
    assert.equal(loaded.userId, 'user_xyz');
    assert.equal(loaded.userEmail, 'test@example.com');
    assert.equal(loaded.userName, 'Test User');
    assert.equal(loaded.sessionId, 'sess_abc');
    assert.equal(loaded.isExpired, false);
  });

  it('clears token correctly', () => {
    store.clearToken();
    assert.equal(store.loadToken(), null);
    assert.equal(store.hasValidToken(), false);
  });

  it('identifies expired tokens', () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    store.saveToken('expired-token', 'sess_old', 'user_old', 'old@example.com', 'Old User', pastExpiry);

    assert.equal(store.hasValidToken(), false);
    const loaded = store.loadToken();
    assert.notEqual(loaded, null);
    assert.equal(loaded.isExpired, true);
  });

  it('zero expiry is treated as expired', () => {
    store.saveToken('zero-token', 'sess_zero', 'user_zero', '', '', 0);
    assert.equal(store.hasValidToken(), false);
    const loaded = store.loadToken();
    assert.notEqual(loaded, null);
    assert.equal(loaded.isExpired, true);
  });
});

describe('Auth Manager State Transitions', () => {
  let enc, store, context, manager;

  before(() => {
    enc = new TokenEncryption();
    store = new TokenStore(enc);
    context = new AuthContext();
    context.INI_ClerkSecretKey = 'sk_test_fake_key';
    context.INI_ClerkPublishableKey = 'pk_test_fake_key';
    context.INI_ClerkDomain = 'test.clerk.accounts.dev';
    manager = new AuthManager(context, store);
  });

  it('starts unauthenticated', () => {
    assert.equal(manager.isAuthenticated, false);
    assert.equal(context.Auth_IsAuthenticated, false);
    assert.equal(manager.currentUserName, '');
  });

  it('remains unauthenticated after initializeFromCache with no cached token', () => {
    manager.initializeFromCache();
    assert.equal(manager.isAuthenticated, false);
  });

  it('authenticates on sign-in', () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    manager.simulateSignIn({
      sessionToken: 'jwt-token-123',
      sessionId: 'sess_live',
      userId: 'user_live',
      userEmail: 'live@test.com',
      userName: 'Live User',
      tokenExpiry: futureExpiry
    });

    assert.equal(manager.isAuthenticated, true);
    assert.equal(context.Auth_IsAuthenticated, true);
    assert.equal(context.Auth_UserId, 'user_live');
    assert.equal(context.Auth_UserEmail, 'live@test.com');
    assert.equal(context.Auth_UserName, 'Live User');
    assert.equal(context.Auth_SessionToken, 'jwt-token-123');
    assert.equal(manager.currentUserName, 'Live User');
  });

  it('restores from cache after sign-in', () => {
    const context2 = new AuthContext();
    context2.INI_ClerkSecretKey = 'sk_test_fake_key';
    const manager2 = new AuthManager(context2, store);
    manager2.initializeFromCache();

    assert.equal(manager2.isAuthenticated, true);
    assert.equal(context2.Auth_UserEmail, 'live@test.com');
    assert.equal(context2.Auth_SessionToken, 'jwt-token-123');
  });

  it('signs out correctly', () => {
    manager.signOut();
    assert.equal(manager.isAuthenticated, false);
    assert.equal(context.Auth_IsAuthenticated, false);
    assert.equal(context.Auth_SessionToken, '');
    assert.equal(context.Auth_UserId, '');
    assert.equal(context.Auth_UserEmail, '');
    assert.equal(store.hasValidToken(), false);
  });

  it('stays unauthenticated after sign-out + initializeFromCache', () => {
    manager.initializeFromCache();
    assert.equal(manager.isAuthenticated, false);
  });
});

describe('Auth Manager — Unconfigured Clerk', () => {
  it('handles missing secret key gracefully', () => {
    const context = new AuthContext();
    context.INI_ClerkSecretKey = '';
    const store = new TokenStore(new TokenEncryption());
    const manager = new AuthManager(context, store);
    manager.initializeFromCache();
    assert.equal(manager.isAuthenticated, false);
  });
});

describe('Auth Manager — Expired Cache', () => {
  it('clears expired cached token on initialize', () => {
    const enc = new TokenEncryption();
    const store = new TokenStore(enc);
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    store.saveToken('expired-jwt', 'sess_exp', 'user_exp', 'exp@test.com', 'Expired', pastExpiry);

    const context = new AuthContext();
    context.INI_ClerkSecretKey = 'sk_test_key';
    const manager = new AuthManager(context, store);
    manager.initializeFromCache();

    assert.equal(manager.isAuthenticated, false);
    assert.equal(store.hasValidToken(), false);
  });
});

describe('Clerk API Response Parsing — Session', () => {
  it('parses a valid active session', () => {
    const json = JSON.stringify({
      id: 'sess_abc123',
      user_id: 'user_xyz789',
      status: 'active',
      expire_at: 1700000000,
      last_active_at: 1699999000
    });
    const info = parseSessionInfo(json);
    assert.notEqual(info, null);
    assert.equal(info.sessionId, 'sess_abc123');
    assert.equal(info.userId, 'user_xyz789');
    assert.equal(info.status, 'active');
    assert.equal(info.expireAt, 1700000000);
    assert.equal(info.lastActiveAt, 1699999000);
  });

  it('returns null for expired session', () => {
    const json = JSON.stringify({ id: 'sess_old', user_id: 'user_old', status: 'expired', expire_at: 0, last_active_at: 0 });
    assert.equal(parseSessionInfo(json), null);
  });

  it('returns null for revoked session', () => {
    const json = JSON.stringify({ id: 'sess_rev', user_id: 'user_rev', status: 'revoked' });
    assert.equal(parseSessionInfo(json), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseSessionInfo('not json'), null);
    assert.equal(parseSessionInfo(''), null);
    assert.equal(parseSessionInfo('{}'), null); // missing status
  });
});

describe('Clerk API Response Parsing — User', () => {
  it('parses a full user with primary email', () => {
    const json = JSON.stringify({
      id: 'user_abc',
      first_name: 'John',
      last_name: 'Doe',
      primary_email_address_id: 'idn_email1',
      email_addresses: [
        { id: 'idn_email1', email_address: 'john@example.com' },
        { id: 'idn_email2', email_address: 'john.alt@example.com' }
      ],
      created_at: 1699000000,
      updated_at: 1699500000
    });
    const user = parseUserInfo(json);
    assert.notEqual(user, null);
    assert.equal(user.userId, 'user_abc');
    assert.equal(user.firstName, 'John');
    assert.equal(user.lastName, 'Doe');
    assert.equal(user.email, 'john@example.com');
    assert.equal(user.displayName, 'John Doe');
  });

  it('falls back to email when no name', () => {
    const json = JSON.stringify({
      id: 'user_noname',
      first_name: null,
      last_name: null,
      primary_email_address_id: 'idn_e1',
      email_addresses: [{ id: 'idn_e1', email_address: 'nemo@test.com' }],
      created_at: 0, updated_at: 0
    });
    const user = parseUserInfo(json);
    assert.equal(user.displayName, 'nemo@test.com');
  });

  it('handles first name only', () => {
    const json = JSON.stringify({
      id: 'user_first', first_name: 'Jane', last_name: '',
      primary_email_address_id: 'idn_e', email_addresses: [{ id: 'idn_e', email_address: 'jane@test.com' }],
      created_at: 0, updated_at: 0
    });
    const user = parseUserInfo(json);
    assert.equal(user.displayName, 'Jane');
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseUserInfo('bad'), null);
  });
});

describe('JSON String Escaping', () => {
  it('escapes backslashes', () => {
    assert.equal(escapeJsonString('a\\b'), 'a\\\\b');
  });

  it('escapes quotes', () => {
    assert.equal(escapeJsonString('say "hello"'), 'say \\"hello\\"');
  });

  it('escapes newlines and tabs', () => {
    assert.equal(escapeJsonString('line1\nline2'), 'line1\\nline2');
    assert.equal(escapeJsonString('col1\tcol2'), 'col1\\tcol2');
  });

  it('escapes carriage returns', () => {
    assert.equal(escapeJsonString('a\rb'), 'a\\rb');
  });

  it('handles empty/null', () => {
    assert.equal(escapeJsonString(''), '');
    assert.equal(escapeJsonString(null), '');
    assert.equal(escapeJsonString(undefined), '');
  });

  it('preserves normal text', () => {
    assert.equal(escapeJsonString('hello world 123'), 'hello world 123');
  });
});

describe('Auth Context Properties', () => {
  it('defaults to unauthenticated', () => {
    const ctx = new AuthContext();
    assert.equal(ctx.Auth_IsAuthenticated, false);
    assert.equal(ctx.Auth_UserId, '');
    assert.equal(ctx.Auth_SessionToken, '');
    assert.equal(ctx.Auth_TokenExpiry, 0);
  });

  it('stores and retrieves all properties', () => {
    const ctx = new AuthContext();
    ctx.Auth_IsAuthenticated = true;
    ctx.Auth_UserId = 'user_test';
    ctx.Auth_UserEmail = 'test@clerk.com';
    ctx.Auth_UserName = 'Test User';
    ctx.Auth_SessionToken = 'jwt_xxx';
    ctx.Auth_TokenExpiry = 999999;
    ctx.INI_ClerkPublishableKey = 'pk_test_abc';
    ctx.INI_ClerkSecretKey = 'sk_test_xyz';
    ctx.INI_ClerkDomain = 'my.clerk.accounts.dev';

    assert.equal(ctx.Auth_IsAuthenticated, true);
    assert.equal(ctx.Auth_UserId, 'user_test');
    assert.equal(ctx.Auth_UserEmail, 'test@clerk.com');
    assert.equal(ctx.Auth_UserName, 'Test User');
    assert.equal(ctx.Auth_SessionToken, 'jwt_xxx');
    assert.equal(ctx.Auth_TokenExpiry, 999999);
    assert.equal(ctx.INI_ClerkPublishableKey, 'pk_test_abc');
    assert.equal(ctx.INI_ClerkSecretKey, 'sk_test_xyz');
    assert.equal(ctx.INI_ClerkDomain, 'my.clerk.accounts.dev');
  });
});

describe('INI Config Parsing — Clerk Keys', () => {
  /** Simulates the INI parsing logic from SharedMethods.LoadConfig.vb */
  function parseClerkConfig(iniContent) {
    const configDict = {};
    for (const line of iniContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        configDict[key.toLowerCase()] = { key, value };
      }
    }
    return {
      clerkPublishableKey: configDict['clerkpublishablekey']?.value || '',
      clerkSecretKey: configDict['clerksecretkey']?.value || '',
      clerkDomain: configDict['clerkdomain']?.value || ''
    };
  }

  it('parses all three Clerk keys from INI', () => {
    const ini = `
; Clerk Authentication
ClerkPublishableKey = pk_test_abc123
ClerkSecretKey = sk_test_xyz789
ClerkDomain = trusty-redbird-51.clerk.accounts.dev
`;
    const cfg = parseClerkConfig(ini);
    assert.equal(cfg.clerkPublishableKey, 'pk_test_abc123');
    assert.equal(cfg.clerkSecretKey, 'sk_test_xyz789');
    assert.equal(cfg.clerkDomain, 'trusty-redbird-51.clerk.accounts.dev');
  });

  it('returns empty for missing keys', () => {
    const cfg = parseClerkConfig('; no clerk config\nAPIKey = something');
    assert.equal(cfg.clerkPublishableKey, '');
    assert.equal(cfg.clerkSecretKey, '');
    assert.equal(cfg.clerkDomain, '');
  });

  it('skips comment lines', () => {
    const ini = `;ClerkPublishableKey = pk_test_hidden\nClerkPublishableKey = pk_test_real`;
    const cfg = parseClerkConfig(ini);
    assert.equal(cfg.clerkPublishableKey, 'pk_test_real');
  });
});

describe('Sign-In HTML Generation', () => {
  /** Simulates the key parts of ClerkSignInDialog.GenerateSignInHtml. */
  function generateSignInHtml(publishableKey, clerkDomain) {
    const escapedKey = publishableKey.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const escapedDomain = clerkDomain.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `<script data-clerk-publishable-key='${escapedKey}' src='https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js'></script>`;
  }

  it('embeds publishable key in HTML', () => {
    const html = generateSignInHtml('pk_test_abc', 'my.clerk.dev');
    assert.ok(html.includes("data-clerk-publishable-key='pk_test_abc'"));
    assert.ok(html.includes('clerk.browser.js'));
  });

  it('escapes special characters in key', () => {
    const html = generateSignInHtml("pk_test_has'quote", 'my.clerk.dev');
    assert.ok(html.includes("pk_test_has\\'quote"));
    assert.ok(!html.includes("pk_test_has'quote"));
  });
});
