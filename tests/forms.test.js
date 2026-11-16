'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, loginAs, signupAs } = require('./helpers');

async function createForm(app, cookie, name) {
  const result = await request(app.base, '/api/forms', { method: 'POST', cookie, json: { name } });
  assert.equal(result.status, 201, `unexpected status ${result.status}: ${result.text}`);
  return result.json.form;
}

test('forms: create, list and read one owned endpoint with counts', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');

  const form = await createForm(app, cookie, 'Careers page');
  assert.match(form.id, /^[A-Za-z0-9_-]{8,}$/);
  assert.equal(form.name, 'Careers page');
  assert.equal(form.endpointPath, `/f/${form.id}`);
  assert.equal(form.submissionCount, 0);
  assert.equal(form.spamCount, 0);

  const list = await request(app.base, '/api/forms', { cookie });
  assert.equal(list.status, 200);
  const created = list.json.forms.find((item) => item.id === form.id);
  assert.ok(created, 'the new form appears in the list');
  assert.equal(created.endpointUrl, `${app.base}/f/${form.id}`);

  const single = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(single.status, 200);
  assert.equal(single.json.form.name, 'Careers page');
});

test('forms: the HTML create panel persists a form and shows it on the dashboard', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');

  const created = await request(app.base, '/app/forms', {
    method: 'POST',
    cookie,
    form: { name: 'Press enquiries' },
    origin: app.base,
  });
  assert.equal(created.status, 303);
  assert.match(created.location, /^\/app\?created=/);

  const dashboard = await request(app.base, created.location, { cookie });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Press enquiries/);
  assert.match(dashboard.text, /Form created/);
});

test('forms: a blank name is rejected with an inline error and no record is created', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');

  const before = await request(app.base, '/api/forms', { cookie });
  const rejected = await request(app.base, '/app/forms', {
    method: 'POST',
    cookie,
    form: { name: '   ' },
    origin: app.base,
  });
  assert.equal(rejected.status, 422);
  assert.match(rejected.text, /Give the form a name/);

  const after = await request(app.base, '/api/forms', { cookie });
  assert.equal(after.json.forms.length, before.json.forms.length);
});

test('forms: every route is scoped to the owner and cross-account ids return 404', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const owner = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const stranger = await signupAs(app.base, 'stranger@example.com', 'a-long-password');

  const form = await createForm(app, owner.cookie, 'Owner only');

  const read = await request(app.base, `/api/forms/${form.id}`, { cookie: stranger.cookie });
  assert.equal(read.status, 404);

  const update = await request(app.base, `/api/forms/${form.id}`, {
    method: 'PATCH',
    cookie: stranger.cookie,
    json: { name: 'Hijacked' },
  });
  assert.equal(update.status, 404);

  const remove = await request(app.base, `/api/forms/${form.id}`, { method: 'DELETE', cookie: stranger.cookie });
  assert.equal(remove.status, 404);

  const submissions = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie: stranger.cookie });
  assert.equal(submissions.status, 404);

  const exportCsv = await request(app.base, `/api/forms/${form.id}/submissions/export.csv`, { cookie: stranger.cookie });
  assert.equal(exportCsv.status, 404);

  const page = await request(app.base, `/app/forms/${form.id}`, { cookie: stranger.cookie });
  assert.equal(page.status, 404);

  const stillThere = await request(app.base, `/api/forms/${form.id}`, { cookie: owner.cookie });
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.json.form.name, 'Owner only');
});

test('forms: settings persist, validate, and drive the origin allowlist', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Embedded form');

  const saved = await request(app.base, `/app/forms/${form.id}/settings`, {
    method: 'POST',
    cookie,
    form: {
      name: 'Embedded form v2',
      allowedOrigins: 'https://static.example.com\nhttps://app.example.com',
      honeypotEnabled: 'yes',
      honeypotField: 'company',
    },
    origin: app.base,
  });
  assert.equal(saved.status, 303);
  assert.match(saved.location, /saved=1$/);

  const reloaded = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(reloaded.json.form.name, 'Embedded form v2');
  assert.deepEqual(reloaded.json.form.allowedOrigins, ['https://static.example.com', 'https://app.example.com']);
  assert.equal(reloaded.json.form.honeypotEnabled, true);
  assert.equal(reloaded.json.form.honeypotField, 'company');

  const blocked = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Outsider&message=hello',
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://not-allowed.example',
  });
  assert.equal(blocked.status, 403);

  const accepted = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Visitor&message=hello',
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://static.example.com',
  });
  assert.equal(accepted.status, 200);

  const counts = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(counts.json.form.submissionCount, 1);
});

test('forms: an invalid origin is rejected without changing the saved settings', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Validation form');

  const bad = await request(app.base, `/app/forms/${form.id}/settings`, {
    method: 'POST',
    cookie,
    form: { name: 'Validation form', allowedOrigins: 'nonsense-origin' },
    origin: app.base,
  });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /is not a full URL/);

  const unchanged = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.deepEqual(unchanged.json.form.allowedOrigins, []);
});

test('forms: deleting an endpoint removes its submissions too', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Temporary form');

  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Visitor&message=hello',
    contentType: 'application/x-www-form-urlencoded',
  });
  const withSubmission = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(withSubmission.json.form.submissionCount, 1);

  const removed = await request(app.base, `/api/forms/${form.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);

  const gone = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(gone.status, 404);

  const publicPage = await request(app.base, `/f/${form.id}`);
  assert.equal(publicPage.status, 404);

  const db = JSON.parse(require('node:fs').readFileSync(require('node:path').join(app.dataDir, 'db.json'), 'utf8'));
  assert.equal(db.submissions.filter((submission) => submission.formId === form.id).length, 0);
});

test('forms: forms, settings and submissions survive a restart, and the demo data is seeded once', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Restart proof');

  await request(app.base, `/app/forms/${form.id}/settings`, {
    method: 'POST',
    cookie,
    form: { name: 'Restart proof', allowedOrigins: '', honeypotEnabled: 'yes', honeypotField: 'nickname' },
    origin: app.base,
  });
  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Persisted&message=still+here',
    contentType: 'application/x-www-form-urlencoded',
  });

  await app.restart();

  const relogin = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  assert.equal(relogin.status, 200);

  const reloaded = await request(app.base, `/api/forms/${form.id}`, { cookie: relogin.cookie });
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.json.form.name, 'Restart proof');
  assert.equal(reloaded.json.form.honeypotEnabled, true);
  assert.equal(reloaded.json.form.honeypotField, 'nickname');
  assert.equal(reloaded.json.form.submissionCount, 1);

  const list = await request(app.base, '/api/forms', { cookie: relogin.cookie });
  assert.equal(list.json.forms.filter((item) => item.name === 'Product waitlist').length, 1, 'seed is not duplicated');
  assert.equal(list.json.forms.filter((item) => item.name === 'Support contact').length, 1);

  const db = JSON.parse(require('node:fs').readFileSync(require('node:path').join(app.dataDir, 'db.json'), 'utf8'));
  assert.equal(db.users.filter((user) => user.email === 'cenius@cenius.ai').length, 1);
});

test('forms: the public example form on this instance still posts when an allowlist is set', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Allowlisted form');

  await request(app.base, `/app/forms/${form.id}/settings`, {
    method: 'POST',
    cookie,
    form: { name: 'Allowlisted form', allowedOrigins: 'https://owner-site.example', honeypotEnabled: 'yes', honeypotField: 'website' },
    origin: app.base,
  });

  const fromInstance = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Owner+test&message=checking+the+endpoint',
    contentType: 'application/x-www-form-urlencoded',
    origin: app.base,
  });
  assert.equal(fromInstance.status, 200, 'the instance\'s own example form must keep working');

  const fromOwnerSite = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Owner+site&message=live+form',
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://owner-site.example',
  });
  assert.equal(fromOwnerSite.status, 200);

  const fromStranger = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Stranger&message=not+allowed',
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://stranger.example',
  });
  assert.equal(fromStranger.status, 403);
  assert.match(fromStranger.text, /only accepts posts from/);

  const counts = await request(app.base, `/api/forms/${form.id}`, { cookie });
  assert.equal(counts.json.form.submissionCount, 2);
});
