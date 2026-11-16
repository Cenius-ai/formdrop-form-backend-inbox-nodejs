'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, loginAs, signupAs } = require('./helpers');

test('auth: demo account signs in, reads itself, and sees seeded endpoints', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const login = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  assert.equal(login.status, 200);
  assert.match(login.cookie, /^formdrop_session=/);
  assert.equal(login.json.user.email, 'cenius@cenius.ai');

  const me = await request(app.base, '/api/auth/me', { cookie: login.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'cenius@cenius.ai');
  assert.equal(me.json.user.isDemo, true);

  const forms = await request(app.base, '/api/forms', { cookie: login.cookie });
  assert.equal(forms.status, 200);
  assert.equal(forms.json.forms.length, 2);
  assert.ok(forms.json.forms.every((form) => form.submissionCount > 0));

  const dashboard = await request(app.base, '/app', { cookie: login.cookie });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Product waitlist/);
  assert.match(dashboard.text, /\/f\//);
});

test('auth: the login page shows the seeded demo credentials and the form controls', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const page = await request(app.base, '/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /Demo: cenius@cenius\.ai \/ cenius/);
  assert.match(page.text, /demo@formdrop\.dev \/ demo1234/);
  assert.match(page.text, /name="email"/);
  assert.match(page.text, /type="password"/);
  assert.match(page.text, /data-password-toggle/);
  assert.match(page.text, /action="\/login"/);
});

test('auth: the HTML login form sets a cookie and redirects into the app', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const result = await request(app.base, '/login', {
    method: 'POST',
    form: { mode: 'login', email: 'cenius@cenius.ai', password: 'cenius' },
    origin: app.base,
  });
  assert.equal(result.status, 303);
  assert.equal(result.location, '/app');
  assert.match(result.cookie, /^formdrop_session=/);

  const dashboard = await request(app.base, '/app', { cookie: result.cookie });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Your form endpoints/);
});

test('auth: unknown email and wrong password share one non-enumerating message', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const wrongPassword = await request(app.base, '/api/auth/login', {
    method: 'POST',
    json: { email: 'cenius@cenius.ai', password: '***REDACTED-SECRET***' },
  });
  const unknownEmail = await request(app.base, '/api/auth/login', {
    method: 'POST',
    json: { email: 'nobody@example.com', password: '***REDACTED-SECRET***' },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.equal(wrongPassword.json.message, unknownEmail.json.message);
  assert.equal(wrongPassword.json.message, 'Email or password is incorrect.');
  assert.equal(wrongPassword.cookie, '');
});

test('auth: sign-up creates a working account with an empty workspace, duplicates are rejected', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const created = await signupAs(app.base, 'newcomer@example.com', 'a-long-password');
  assert.equal(created.status, 201);
  assert.match(created.cookie, /^formdrop_session=/);

  const me = await request(app.base, '/api/auth/me', { cookie: created.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'newcomer@example.com');

  const forms = await request(app.base, '/api/forms', { cookie: created.cookie });
  assert.equal(forms.status, 200);
  assert.deepEqual(forms.json.forms, []);

  const dashboard = await request(app.base, '/app', { cookie: created.cookie });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /No endpoints yet/);

  const duplicate = await signupAs(app.base, 'newcomer@example.com', 'a-long-password');
  assert.equal(duplicate.status, 409);
});

test('auth: sign-up validates short passwords and malformed emails', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const shortPassword = await signupAs(app.base, 'short@example.com', 'abc');
  assert.equal(shortPassword.status, 400);
  assert.ok(shortPassword.json.errors.password);

  const badEmail = await signupAs(app.base, 'not-an-email', 'a-long-password');
  assert.equal(badEmail.status, 400);
  assert.ok(badEmail.json.errors.email);
});

test('auth: logout destroys the session server-side', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const login = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const logout = await request(app.base, '/api/auth/logout', { method: 'POST', cookie: login.cookie });
  assert.equal(logout.status, 200);

  const me = await request(app.base, '/api/auth/me', { cookie: login.cookie });
  assert.equal(me.status, 401);
});

test('auth: protected routes redirect anonymous visitors to the login page', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const root = await request(app.base, '/');
  assert.equal(root.status, 302);
  assert.equal(root.location, '/login');

  const dashboard = await request(app.base, '/app');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.location, '/login');

  const api = await request(app.base, '/api/forms');
  assert.equal(api.status, 401);
});

test('auth: passwords are stored as salted scrypt hashes, never plaintext', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const db = JSON.parse(require('node:fs').readFileSync(require('node:path').join(app.dataDir, 'db.json'), 'utf8'));
  const demo = db.users.find((user) => user.email === 'cenius@cenius.ai');
  assert.ok(demo);
  assert.notEqual(demo.passwordHash, 'cenius');
  assert.match(demo.passwordHash, /^[0-9a-f]{128}$/);
  assert.match(demo.passwordSalt, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(db).includes('"password":"cenius"'), false);
});
