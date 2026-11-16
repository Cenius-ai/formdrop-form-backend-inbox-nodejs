# Installing Formdrop

Formdrop is a single Node process with no runtime dependencies. "Install" means:
check Node, create the data directory, seed the demo workspace. Then start the server.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 20 or newer | `node --version` must print `v20.x` or higher. No npm packages are installed or needed. |
| A writable project directory | Formdrop writes `data/db.json` next to `main.js`. |
| A free TCP port | Defaults to `3000`; override with `PORT`. |

Nothing else is installed: no database server, no package manager step, no build step.
Formdrop never downloads fonts, scripts or images at runtime — they ship in `static/`.

## Step 1 — prepare and seed

```bash
bash install.sh
```

The script:

1. verifies that `node` exists and is version 20 or newer,
2. creates `data/`,
3. runs `node main.js --seed` to write `data/db.json` with the demo users, two demo
   workspaces, their forms and sample submissions.

It then exits. It never starts the web server, so it can be re-run safely at any time
(the seed is idempotent and will not duplicate data).

## Step 2 — start the server

```bash
node main.js
```

You should see:

```
[formdrop] listening on http://0.0.0.0:3000
[formdrop] demo login: cenius@cenius.ai / cenius
```

Open <http://localhost:3000>. `GET /` redirects to `/login`, and `GET /health` answers
`ok` for uptime checks.

To bind a different address or port:

```bash
PORT=8080 HOST=0.0.0.0 node main.js
```

## Step 3 — sign in

Use the credentials printed on the login card:

- `cenius@cenius.ai` / `cenius` — the primary demo workspace (two endpoints, mixed
  inbox and spam submissions)
- `demo@formdrop.dev` / `demo1234` — a second seeded workspace

Remove or re-password the demo accounts before exposing a real deployment.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to bind |
| `HOST` | `0.0.0.0` | Interface to bind |
| `FORMDROP_DATA_DIR` | `./data` | Directory for `db.json` |

`.env.example` lists the same variables with their defaults. A `.env` file in the project
root is read at startup if present; every value is optional, so `node main.js` works with
no environment at all.

## Running behind a proxy

Formdrop reads `X-Forwarded-Proto` to decide whether to mark the session cookie `Secure`,
so terminating TLS in nginx/Caddy works without configuration. The displayed endpoint
URLs are built from the request `Host` header — send the public hostname through.

## Optional: run on boot

A minimal systemd unit (create it yourself; `install.sh` never touches system services):

```ini
[Unit]
Description=Formdrop form backend
After=network.target

[Service]
WorkingDirectory=/srv/formdrop
ExecStart=/usr/bin/node main.js
Environment=PORT=3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `error: Node.js 20 or newer is required` | Upgrade Node; Formdrop uses the built-in `node:test` runner and modern `node:` imports. |
| `listen EADDRINUSE` | Another process holds the port. Set `PORT=3001 node main.js`. |
| The server refuses to start with a JSON parse error | `data/db.json` is corrupt. Restore a backup, or move the file aside to start from a fresh seeded database. |
| A public post returns `403` | The form has an allowed-origins list and the request's `Origin` is not on it. Add the origin in the form settings. |
| A public post returns `413` | The body exceeded the 64 KB cap. |
| Nothing renders and the console shows a CSP error | Serve the app through `node main.js` (it sets the CSP headers) rather than opening `main.js` output through another proxy that rewrites headers. |
