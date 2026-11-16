# Using Formdrop

A walkthrough of everything the running app does. Start with `node main.js` and open
<http://localhost:3000>.

## 1. Sign in

The card on `/login` has two tabs — **Sign in** and **Create account** — plus a demo card
that shows `cenius@cenius.ai` / `cenius`. The **Show/Hide** button toggles the password
field, and **Use demo credentials** fills the form for you.

- Signing in with the demo account lands on `/app`, a workspace with two endpoints
  already collecting submissions.
- Creating an account lands on the same page with an empty state inviting your first form.
- A wrong password and an unknown email produce the same message: "Email or password is
  incorrect." Field-level validation appears inline before any request is made.

## 2. Create an endpoint

On `/app`, type a name into **New endpoint** (for example `Press enquiries`) and press
**Create form**. The endpoint appears immediately in the **Endpoints** table with:

- its public URL (`http://<host>/f/<id>`) and a **Copy URL** button,
- live **Inbox / Spam / Total** counts,
- **Open inbox** and **View form** links.

The row also shows the honeypot and origin policy currently in force. The dashboard's
stat strip summarises endpoints, inbox volume, spam volume and how recently the newest
submission arrived.

## 3. Send a test submission

Click **View form** (or open `/f/<id>` directly). That page is the example form Formdrop
renders for the endpoint — Name, Email, Message — followed by an embed snippet showing the
real `action` URL to paste into your static site.

Submit it. You get a thank-you page, and the submission is stored with every field name
the form posted.

## 4. Read the inbox

Back in **Open inbox** (`/app/forms/<id>`):

- The filters **All / Inbox / Spam** each show a live count and reload the table.
- Each row shows when it arrived (relative time, exact timestamp inside), who sent it, a
  snippet, and its status pill.
- Click a row to expand it: every submitted field name and value, the origin it came from,
  the flag reason if any, plus **Mark as spam / Mark as not spam** and **Delete
  submission** (which requires ticking **Confirm** first).
- `Export CSV` downloads the rows currently in view.

## 5. Configure origins and the honeypot

The settings panel on the same page is saved in one step:

- **Form name** — rename the endpoint; the dashboard, breadcrumb and public page update.
- **Allowed origins** — one full URL per line (`https://example.com`). With at least one
  entry, posts whose `Origin` header is not on the list are rejected with `403`, and the
  rejection page names both the allowed origins and the one received. Posts from this
  Formdrop instance itself (the public example form) are always accepted, so you can test
  an allowlisted endpoint from its own page. Leave the box empty to accept posts from
  anywhere. Invalid lines keep the panel open with an inline error and do not overwrite
  what is saved.
- **Honeypot** — tick the toggle and set the hidden field name (`website` by default). The
  public page then renders that hidden input; any post that fills it is stored as spam
  with a readable reason.
- **Effective settings** — a short summary of what is enforced right now.
- **Delete endpoint** — removes the endpoint and all of its submissions after you tick the
  confirmation box.

## 6. Export CSV

`Export CSV` hits
`/api/forms/:id/submissions/export.csv?filter=<current filter>` and downloads
`formdrop-<form-name>-<filter>.csv`. The header is `id`, `submitted_at`, `spam`, then every
field name in the exported rows. Commas, quotes and newlines are quoted per RFC 4180, and
values that would start a spreadsheet formula are prefixed with `'`.

## 7. Keyboard and navigation extras

- `⌘K` / `Ctrl-K` opens the command palette: type to filter endpoints and pages, use the
  arrow keys and Enter to jump.
- The top bar always shows where you are, who is signed in, and **Sign out**.
- Every control is reachable with Tab, has a visible focus ring, and works without
  JavaScript (the palette and clipboard buttons are enhancements only).

## 8. What the data looks like

`data/db.json` holds five collections:

```json
{
  "users": [],
  "sessions": [],
  "forms": [],
  "submissions": [],
  "meta": { "seededWorkspaces": {} }
}
```

Submissions keep `fields` as an object of whatever names were posted, so a form with
`full_name`, `work-email` and `budget` is stored and exported exactly as submitted —
no configuration required.
