'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, request, loginAs, multipartBody } = require('./helpers');

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

async function createForm(app, cookie, name) {
  const result = await request(app.base, '/api/forms', { method: 'POST', cookie, json: { name } });
  assert.equal(result.status, 201, result.text);
  return result.json.form;
}

async function saveSettings(app, cookie, form, settings) {
  const result = await request(app.base, `/app/forms/${form.id}/settings`, {
    method: 'POST',
    cookie,
    form: {
      name: settings.name === undefined ? form.name : settings.name,
      allowedOrigins: settings.allowedOrigins || '',
      ...(settings.honeypotEnabled ? { honeypotEnabled: 'yes' } : {}),
      honeypotField: settings.honeypotField || 'website',
    },
    origin: app.base,
  });
  assert.equal(result.status, 303, result.text);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      continue;
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test('submissions: urlencoded post stores arbitrary field names and shows them in the inbox', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Arbitrary fields');

  const posted = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: new URLSearchParams({
      full_name: 'Robin Fields',
      'work-email': 'robin@example.com',
      budget: '1200',
      message: 'Please quote for a five page site.',
    }).toString(),
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(posted.status, 200);
  assert.match(posted.text, /Submission received/);

  const inbox = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.counts.all, 1);
  const stored = inbox.json.submissions[0];
  assert.equal(stored.fields.full_name, 'Robin Fields');
  assert.equal(stored.fields['work-email'], 'robin@example.com');
  assert.equal(stored.fields.budget, '1200');
  assert.equal(stored.isSpam, false);
  assert.ok(stored.submittedAt);

  const page = await request(app.base, `/app/forms/${form.id}`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Robin Fields/);
  assert.match(page.text, /work-email/);
});

test('submissions: multipart posts are accepted and stored with the same values', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Multipart form');

  const boundary = '----formdropboundary42';
  const body = multipartBody(boundary, {
    name: 'Ángela Ruiz',
    email: 'angela@example.com',
    message: 'Multipart post with an accent — and a dash.',
  });

  const posted = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(posted.status, 200);

  const inbox = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  assert.equal(inbox.json.counts.all, 1);
  assert.equal(inbox.json.submissions[0].fields.name, 'Ángela Ruiz');
  assert.match(inbox.json.submissions[0].fields.message, /accent/);
});

test('submissions: the honeypot stores a filled field as spam and an empty one as inbox', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Honeypot form');
  await saveSettings(app, cookie, form, { honeypotEnabled: true, honeypotField: 'website' });

  const publicPage = await request(app.base, `/f/${form.id}`);
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /name="website"/);
  assert.match(publicPage.text, /Embed it on your site/);

  const botPost = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Bot&message=buy+links&website=https%3A%2F%2Fspam.example',
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(botPost.status, 200);

  const humanPost = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Human&message=hello&website=',
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(humanPost.status, 200);

  const spam = await request(app.base, `/api/forms/${form.id}/submissions?filter=spam`, { cookie });
  assert.equal(spam.json.counts.spam, 1);
  assert.match(spam.json.submissions[0].spamReason, /Honeypot/);
  assert.equal(spam.json.submissions[0].fields.name, 'Bot');

  const inbox = await request(app.base, `/api/forms/${form.id}/submissions?filter=inbox`, { cookie });
  assert.equal(inbox.json.counts.inbox, 1);
  assert.equal(inbox.json.submissions[0].fields.name, 'Human');
});

test('submissions: oversized and malformed posts are rejected without storing anything', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Limits form');

  const oversized = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: `message=${'a'.repeat(70000)}`,
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(oversized.status, 413);

  const wrongType = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: '{"message":"json is not accepted here"}',
    contentType: 'application/json',
  });
  assert.equal(wrongType.status, 415);

  const empty = await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: '',
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(empty.status, 400);

  const inbox = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  assert.equal(inbox.json.counts.all, 0);
});

test('submissions: unknown endpoints answer 404 on both the page and the post', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());

  const page = await request(app.base, '/f/does-not-exist');
  assert.equal(page.status, 404);

  const post = await request(app.base, '/f/does-not-exist', {
    method: 'POST',
    body: 'name=x',
    contentType: FORM_CONTENT_TYPE,
  });
  assert.equal(post.status, 404);
});

test('submissions: spam can be toggled and deleted by the owner only', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'Moderation form');

  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Visitor&message=hello',
    contentType: FORM_CONTENT_TYPE,
  });
  const inbox = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  const submission = inbox.json.submissions[0];

  const flagged = await request(app.base, `/api/submissions/${submission.id}`, {
    method: 'PATCH',
    cookie,
    json: { isSpam: true },
  });
  assert.equal(flagged.status, 200);
  assert.equal(flagged.json.submission.isSpam, true);

  const spamOnly = await request(app.base, `/api/forms/${form.id}/submissions?filter=spam`, { cookie });
  assert.equal(spamOnly.json.counts.spam, 1);
  assert.equal(spamOnly.json.counts.inbox, 0);

  const cleared = await request(app.base, `/api/submissions/${submission.id}`, {
    method: 'PATCH',
    cookie,
    json: { isSpam: false },
  });
  assert.equal(cleared.json.submission.isSpam, false);

  const badPayload = await request(app.base, `/api/submissions/${submission.id}`, {
    method: 'PATCH',
    cookie,
    json: { isSpam: 'yes please' },
  });
  assert.equal(badPayload.status, 400);

  const removed = await request(app.base, `/api/submissions/${submission.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);

  const after = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  assert.equal(after.json.counts.all, 0);

  const missing = await request(app.base, `/api/submissions/${submission.id}`, { method: 'DELETE', cookie });
  assert.equal(missing.status, 404);
});

test('submissions: the HTML spam toggle and delete controls update the visible counts', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'HTML moderation');

  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Row Person&message=hello',
    contentType: FORM_CONTENT_TYPE,
  });
  const inbox = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  const submission = inbox.json.submissions[0];

  const flagged = await request(app.base, `/app/forms/${form.id}/submissions/${submission.id}/spam`, {
    method: 'POST',
    cookie,
    form: { isSpam: 'true', filter: 'all' },
    origin: app.base,
  });
  assert.equal(flagged.status, 303);

  const page = await request(app.base, `/app/forms/${form.id}?filter=spam`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Row Person/);
  assert.match(page.text, /Spam/);

  const unconfirmed = await request(app.base, `/app/forms/${form.id}/submissions/${submission.id}/delete`, {
    method: 'POST',
    cookie,
    form: { filter: 'all' },
    origin: app.base,
  });
  assert.equal(unconfirmed.status, 422);
  assert.match(unconfirmed.text, /Tick the confirmation box/);

  const deleted = await request(app.base, `/app/forms/${form.id}/submissions/${submission.id}/delete`, {
    method: 'POST',
    cookie,
    form: { filter: 'all', confirm: 'yes' },
    origin: app.base,
  });
  assert.equal(deleted.status, 303);

  const after = await request(app.base, `/api/forms/${form.id}/submissions`, { cookie });
  assert.equal(after.json.counts.all, 0);
});

test('submissions: CSV export is RFC 4180 quoted, follows the filter, and blocks formula injection', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');
  const form = await createForm(app, cookie, 'CSV export form');
  await saveSettings(app, cookie, form, { honeypotEnabled: true, honeypotField: 'website' });

  const trickyMessage = 'He said "hi", then left\nand wrote more';
  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: new URLSearchParams({ name: 'Comma, Person', email: 'comma@example.com', message: trickyMessage }).toString(),
    contentType: FORM_CONTENT_TYPE,
  });
  await request(app.base, `/f/${form.id}`, {
    method: 'POST',
    body: 'name=Formula&email=formula%40example.com&message=%3D1%2B1&website=bot',
    contentType: FORM_CONTENT_TYPE,
  });

  const exported = await request(app.base, `/api/forms/${form.id}/submissions/export.csv?filter=all`, { cookie });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="formdrop-csv-export-form-all\.csv"/);

  const rows = parseCsv(exported.text);
  assert.deepEqual(rows[0], ['id', 'submitted_at', 'spam', 'name', 'email', 'message', 'website']);
  assert.equal(rows.length, 3);
  const commaRow = rows.slice(1).find((row) => row[3] === 'Comma, Person');
  assert.ok(commaRow, 'the row with commas survives quoting');
  assert.equal(commaRow[5], trickyMessage, 'quotes and newlines survive a round trip');
  const formulaRow = rows.slice(1).find((row) => row[3] === 'Formula');
  assert.equal(formulaRow[5], "'=1+1", 'leading formula characters are neutralised');

  const spamOnly = await request(app.base, `/api/forms/${form.id}/submissions/export.csv?filter=spam`, { cookie });
  const spamRows = parseCsv(spamOnly.text);
  assert.equal(spamRows.length, 2);
  assert.equal(spamRows[1][2], 'spam');
  assert.equal(spamRows[1][3], 'Formula');
});

test('submissions: the inbox page renders every stored field when a row is expanded', async (t) => {
  const app = await startApp();
  t.after(() => app.stop());
  const { cookie } = await loginAs(app.base, 'cenius@cenius.ai', 'cenius');

  const forms = await request(app.base, '/api/forms', { cookie });
  const seeded = forms.json.forms.find((item) => item.name === 'Product waitlist');
  assert.ok(seeded, 'the demo workspace is seeded');

  const page = await request(app.base, `/app/forms/${seeded.id}`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Ada Okafor/);
  assert.match(page.text, /ada@northlight\.studio/);
  assert.match(page.text, /<details class="sub">/);
  assert.match(page.text, /Mark as spam/);
  assert.match(page.text, /Export CSV/);

  const spamFilter = await request(app.base, `/app/forms/${seeded.id}?filter=spam`, { cookie });
  assert.equal(spamFilter.status, 200);
  assert.match(spamFilter.text, /SEO Growth Team/);
  assert.equal(/Ada Okafor/.test(spamFilter.text), false);
});
