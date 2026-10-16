# BetSend

A self-hosted web app for sending large files between people on an office network.

One machine runs the server. Everyone else opens it in a browser — nothing to install.
Drop files, pick who should get them, press Send. The files sit on the server until the
recipients download them or the retention period runs out.

Transfers are **store-and-forward**: the sender and the recipient never need to be online
at the same time.

Everyone signs in with a name and a password. Sessions are server-side cookies, so a
lost laptop can be signed out centrally.

## Two ways to run it

|                | **Office network** (default)            | **Public** (`publicMode`)                       |
| -------------- | --------------------------------------- | ----------------------------------------------- |
| Reachable from | machines on the LAN                     | anywhere, over HTTPS                             |
| Setup          | `Install BetSend.bat` / `install.sh`     | same, plus Caddy in front — see [Putting it on the internet](#putting-it-on-the-internet) |
| Getting an account | admin sends a setup link, or people set their own password | admin sends a setup link — self-service is refused |
| Cookies        | normal                                  | `Secure`, plus HSTS                              |

> ⚠️ **Files are not encrypted at rest.** They sit on the server's disk in the clear until
> they expire, and anyone with access to that machine can read them. Put the storage
> directory on a drive you control, and do not use BetSend for material that needs
> encryption at rest.
>
> If you run it on the LAN, keep it there: don't port-forward port 8080. Exposing it means
> turning on `publicMode` and putting HTTPS in front — the section below covers it.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How people use it](#how-people-use-it)
- [Importing your staff list](#importing-your-staff-list)
- [Configuration](#configuration)
- [How retention and cleanup work](#how-retention-and-cleanup-work)
- [Putting it on the internet](#putting-it-on-the-internet)
- [How it runs in the background](#how-it-runs-in-the-background)
- [Development](#development)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

---

## What it does

- **Send** — drag files (any type, any size) onto the page, pick one or many colleagues,
  add an optional note, press Send.
- **Resumable uploads** — files are chunked with the [tus](https://tus.io) protocol. If the
  network drops or the browser is refreshed, the upload continues from the last confirmed
  chunk instead of starting over. Nothing is ever buffered in memory, so a 10 GB file
  uploads with the same footprint as a 10 MB one.
- **Bulk send without duplication** — sending one file to forty people uploads it once and
  stores exactly one copy on disk, referenced by each recipient.
- **Live notifications** — a WebSocket pushes new transfers to recipients instantly: an
  in-app toast, an inbox badge, and (with permission) a desktop notification.
- **Inbox** — sender, file names, sizes, note, timestamp and an expiry countdown. Download
  files one at a time, or all of them as a zip that is streamed together on the fly.
- **Sent** — see which recipients have downloaded and which have not, and cancel a transfer
  to pull it back.
- **Admin** — manage the user list, watch storage usage, change retention, delete transfers.
- Light and dark mode, following the system preference with a manual toggle.

---

## Requirements

- **Node.js 20 or newer** (22 recommended) on the machine that will host it.
  Download from <https://nodejs.org> — the LTS installer is fine.
- Enough free disk for the files in flight. As a rule of thumb: *(typical transfer size)
  × (transfers per day) × (retention in days)*.
- A wired gigabit connection on the host machine if people will be moving multi-gigabyte
  files.

The server keeps its state in a single SQLite file — there is no database to install.

---

## Quick start

### Windows — installer (recommended)

Download **BetSend-Setup.exe** from the
[latest release](https://github.com/hellqimiclaude/BetSend/releases/latest) and run it.

An ordinary Windows setup wizard: next, next, pick a port and a folder for the files,
install. It carries its own Node.js runtime, so **nothing has to be installed first** —
no Node, no npm, and no C++ compiler. When it finishes it shows the address to hand
round the office and the generated admin token, and BetSend is already running.

It appears in Add/Remove Programs, puts shortcuts in the Start Menu, starts with
Windows, and no console window ever appears.

### Windows — one file, builds from source

Download **[`BetSend-Setup.bat`](https://raw.githubusercontent.com/hellqimiclaude/BetSend/claude/lan-file-transfer-app-b5b9xn/BetSend-Setup.bat)**
(right-click → *Save link as…*) and double-click it. Use this when you want the
current code from the branch rather than a release — it builds on the machine, so
Node.js is installed if missing and a console window shows the progress.

That is the whole thing. It asks Windows for administrator rights, installs Node.js
with winget if it is missing, downloads the current code to `C:\BetSend`, and runs the
installer. Nothing to clone, nothing to unzip, no README to follow.

> Windows will say the file came from the internet. **More info → Run anyway.** That
> warning appears for every unsigned script; if you would rather not trust it, use the
> manual route below, which does the same steps by hand.

Running it again later upgrades in place: your `config.json`, the files people have
sent and the logs are all left alone.

The app folder is small — to keep people's files on a roomier drive:

```powershell
powershell -ExecutionPolicy Bypass -File C:\BetSend\scripts\install.ps1 -StorageDir D:\BetSendData
```

### Windows — manually

1. Install **Node.js LTS** from <https://nodejs.org> (next, next, finish).
2. Put the BetSend folder somewhere permanent — `C:\BetSend` is fine.
3. Double-click **`Install BetSend.bat`** and approve the administrator prompt.

Either way, the installer builds the app, generates an admin token, opens
the firewall for private and domain networks only, registers BetSend to start with
Windows, starts it, and then prints what you need:

```
  ────────────────────────────────────────────────
   BetSend is set up.

   Send this address round the office:
     http://192.168.1.40:8080

   Admin token (for the Admin page):
     8CMIuFNhHYWIxXfQcak1
     Also saved in config.json.

   Next: open the address, go to Admin, paste in your staff list.
  ────────────────────────────────────────────────
```

Send that address round the office. Nobody needs to install anything, and nobody needs
to leave a window open — BetSend now runs in the background, comes back after a reboot,
and restarts itself if it ever falls over.

Options, if you want them:

```powershell
# Drop the ":8080" from the address, and keep files on the D: drive
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Port 80 -StorageDir D:\BetSendData
```

Re-run `Install BetSend.bat` any time after a `git pull` — it rebuilds and restarts, and
keeps your existing `config.json` and all your files.

### Linux

```bash
sudo ./scripts/install.sh                                   # or: --port 80 --storage /srv/betsend
```

Same thing via systemd: builds, configures, enables the `betsend` service and starts it.

### Just want a quick look first?

Double-click **`Start BetSend.bat`** (or run `npm install && npm run build && npm start`).
That runs BetSend in a window for as long as the window stays open — fine for trying it,
not how you want to run it day to day.

Add `npm run seed` for ten made-up colleagues to click around with before the real staff
list is imported.

### Managing it afterwards

| Task    | Windows                                   | Linux                          |
| ------- | ----------------------------------------- | ------------------------------ |
| Restart | `Restart-ScheduledTask -TaskName BetSend` | `systemctl restart betsend`    |
| Stop    | `Stop-ScheduledTask -TaskName BetSend`    | `systemctl stop betsend`       |
| Logs    | `logs\betsend.log`                        | `journalctl -u betsend -f`     |
| Remove  | `scripts\uninstall.ps1`                   | `sudo ./scripts/uninstall.sh`  |

Uninstalling leaves your files and database alone unless you ask for them to go
(`-RemoveData` / `--remove-data`).

---

## How people use it

1. They open the address and sign in with their name and password.
2. That's it — Send, Inbox and Sent are the whole app.

Signing in lasts 30 days (`sessionDays`), so in practice people type a password once a
month. **Sign out** at the bottom of the sidebar ends it immediately.

Names are always *first initial, dot, last name* — `J.Johnson`, `A.Williams`,
`S.O'Brien`. Capitalisation is normalised automatically, so `j.johnson` and `J.JOHNSON`
are the same person.

### Getting people their first password

In Admin, next to each person, **Setup link** produces a one-time URL. Send it to them
however you like — chat, email, or read it out. It works once and expires after 72 hours.
The same button reads **Reset link** for somebody who has forgotten their password.

The server never stores the link itself, only a hash of it, so it is shown exactly once.
If it is lost, generate another.

On a LAN install you can skip that entirely: set **How people get a password** to *Anyone
on the staff list can set their own*, and colleagues create their own password on first
visit. That setting is refused in `publicMode` — on a public URL, the first stranger to
guess a name would own that account.

Passwords must be at least 10 characters and cannot contain the person's own name.

---

## Email

Everybody signs in with their work address, and that address is the identity: it is
what the recipient picker matches on, and being able to receive mail at
**@betlive.com** is what proves somebody works here. There is no separate staff list
to curate.

Three things depend on it:

- **Registering.** A colleague enters their work address and gets a link to choose a
  password. No admin has to hand anything over.
- **Forgotten passwords.** Same thing, self-service.
- **"You have files waiting."** The important one. Store-and-forward means the
  recipient usually is *not* sitting in the app, so without an email a transfer can
  expire unread — the app failing at its one job.

### Pointing it at Exchange

```json
{
  "smtpHost": "mail.betlive.com",
  "smtpPort": 25,
  "smtpFrom": "BetSend <betsend@betlive.com>",
  "emailDomains": ["betlive.com"]
}
```

An internal Exchange relay normally accepts unauthenticated mail from an internal
address on port 25, which is what these defaults assume. Set `smtpUser` and
`smtpPassword` only if yours insists; leave them out and BetSend will not try to
authenticate at all, which is what Exchange usually wants.

Other knobs, rarely needed: `smtpRequireTls` to force STARTTLS, `smtpSecure` for
implicit TLS on 465, and `smtpRejectUnauthorized` if your relay has a certificate
from a CA this machine trusts (it defaults to off, because internal relays usually
do not).

Whoever runs Exchange may need to let this machine's IP relay — that is the usual
reason nothing arrives.

### Check it works

**Admin → Email → Send a test message.** It reports whatever the relay said rather
than a generic failure, so a refusal tells you what to fix. Do this before telling
anyone the address: without mail, nobody can register or reset a password.

`emailDomains` also accepts subdomains, so `@mail.betlive.com` is admitted by
`betlive.com`. Set it to `[]` to accept any domain — only sensible on a closed LAN.

---

## Importing your staff list

Optional: people can register themselves with their work address. Importing just means
they appear in the recipient picker before their first sign-in.

Open **Admin** in the sidebar and enter your `adminToken`. In **User list → Import
people**, paste the addresses:

```
j.johnson@betlive.com
m.smith@betlive.com
a.williams@betlive.com
```

CSV works too — whichever column has the `@` is the address, and the other is used as
the display name:

```csv
name,email
Jo Johnson,j.johnson@betlive.com
Mark Smith,m.smith@betlive.com
```

Without a name, one is derived from the address: `j.johnson@betlive.com` shows up as
`J.Johnson`.

Blank lines and lines starting with `#` are skipped, duplicates are ignored, and anything
that does not match the `X.Lastname` pattern is reported back to you rather than silently
dropped. Re-importing the same list is safe.

### Locking it down

By default anyone with a `@betlive.com` address can register (`registrationMode:
"open"`). Once everybody is imported you can switch **Who can register** to *Only
addresses I have imported* (`registrationMode: "list"`), after which an unknown address
gets no link — and is told nothing either way, so the setting cannot be used to find out
who works here.

Set `requireAdminApproval` if you also want to approve each account by hand after the
address is verified.

Removing someone from Admin takes them out of the directory. Transfers they already sent or
received are left untouched.

---

## Configuration

Settings come from three places, in order of precedence:

1. **Environment variables** — highest priority.
2. **`config.json`** in the working directory (or the path in `CONFIG_FILE`).
3. **Built-in defaults.**

| `config.json` key          | Env var                    | Default    | Meaning                                                              |
| -------------------------- | -------------------------- | ---------- | -------------------------------------------------------------------- |
| `port`                     | `PORT`                     | `8080`     | Port to listen on.                                                   |
| `host`                     | `HOST`                     | `0.0.0.0`  | Interface to bind. `0.0.0.0` = reachable from the LAN.               |
| `storageDir`               | `STORAGE_DIR`              | `./data`   | Where uploaded files and the SQLite database live.                   |
| `dbPath`                   | `DB_PATH`                  | *storageDir*`/betsend.db` | Database file location, if you want it elsewhere.     |
| `adminToken`               | `ADMIN_TOKEN`              | `change-me`| Password for the Admin page. **Change this.**                        |
| `retentionHours`           | `RETENTION_HOURS`          | `72`       | How long a transfer stays available.                                 |
| `maxUploadSize`            | `MAX_UPLOAD_SIZE`          | `0`        | Largest single file, in bytes. `0` = no limit.                       |
| `deleteAfterAllDownloaded` | `DELETE_AFTER_ALL_DOWNLOADED` | `true`  | Delete a transfer as soon as every recipient has downloaded it.      |
| `registrationMode`         | `REGISTRATION_MODE`        | `open`     | `open` = anyone can type a name; `list` = imported names only.        |
| `chunkSizeMb`              | `CHUNK_SIZE_MB`            | `8`        | Upload chunk size. 8–16 MB suits gigabit Ethernet.                   |
| `cleanupIntervalMinutes`   | `CLEANUP_INTERVAL_MINUTES` | `10`       | How often the retention sweep runs.                                  |
| `orphanUploadHours`        | `ORPHAN_UPLOAD_HOURS`      | `24`       | Abandoned part-uploads are deleted after this long.                  |
| `sessionDays`              | `SESSION_DAYS`             | `30`       | How long a sign-in lasts before the password is needed again.        |
| `smtpHost`                 | `SMTP_HOST`                | —          | The office relay, e.g. `mail.betlive.com`. Without it there is no registration or password reset. |
| `smtpPort`                 | `SMTP_PORT`                | `25`       | Exchange's usual internal relay port.                                |
| `smtpFrom`                 | `SMTP_FROM`                | —          | Envelope sender, e.g. `BetSend <betsend@betlive.com>`.               |
| `smtpUser` / `smtpPassword`| `SMTP_USER` / `SMTP_PASSWORD` | —       | Only if your relay demands authentication; omitted means none is attempted. |
| `smtpRequireTls`           | `SMTP_REQUIRE_TLS`         | `false`    | Force STARTTLS.                                                      |
| `smtpSecure`               | `SMTP_SECURE`              | `false`    | Implicit TLS (port 465). Exchange rarely uses this.                  |
| `smtpRejectUnauthorized`   | `SMTP_REJECT_UNAUTHORIZED` | `false`    | Verify the relay's certificate. Off by default: internal relays are usually self-signed. |
| `emailDomains`             | `EMAIL_DOMAINS`            | `betlive.com` | Addresses must end in one of these to register. `[]` accepts any. |
| `notifyByEmail`            | `NOTIFY_BY_EMAIL`          | `true`     | Email recipients when files arrive.                                  |
| `requireAdminApproval`     | `REQUIRE_ADMIN_APPROVAL`   | `false`    | Approve each account by hand even after the address is verified.     |
| `minFreeDiskBytes`         | `MIN_FREE_DISK_BYTES`      | `2 GiB`    | Refuse to start an upload that would leave less free space than this. |
| `perUserUploadBytes`       | `PER_USER_UPLOAD_BYTES`    | `0`        | Cap on bytes one person may have uploaded but not yet sent. `0` = no cap. |
| `logLevel`                 | `LOG_LEVEL`                | `info`     | `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                  |
| `publicMode`               | `PUBLIC_MODE`              | `false`    | Reachable from the internet: `Secure` cookies, HSTS, invite-only sign-up. |
| `behindProxy`              | `BEHIND_PROXY`             | *publicMode* | Trust `X-Forwarded-*`. Only turn on when a proxy really is in front. |
| `publicUrl`                | `PUBLIC_URL`               | —          | e.g. `https://files.example.com`. Makes generated setup links complete. |

`retentionHours`, `maxUploadSize`, `deleteAfterAllDownloaded` and `registrationMode` can
also be changed live from the Admin page — those edits are stored in the database and
override the file. `storageDir` can be edited there too, but only takes effect after a
restart.

---

### What is and is not limited

| | |
| --- | --- |
| File size | **No limit.** `maxUploadSize` is `0`; tus is told 8 PB. |
| Files per transfer | **No limit.** Database queries batch their parameters, so any count works. |
| Note length | **No limit**, up to the 16 MB request body. |
| Recipients | **No limit.** |
| What actually stops an upload | Free disk falling below `minFreeDiskBytes` (2 GiB), which is the only limit on by default. |

Zips larger than 4 GB are handled: the writer switches to ZIP64 automatically, both
for an individual file over 4 GiB and for an archive whose total passes it.

Two ceilings worth knowing about, neither configurable in BetSend:

- **FAT32 cannot hold a file over 4 GB.** Keep `storageDir` on NTFS, which it will be
  unless you point it at an old USB drive.
- **Behind Caddy**, `deploy/Caddyfile` allows an unlimited body but gives a transfer
  six hours to finish. On the LAN that is irrelevant — 10 GB over gigabit takes about
  ninety seconds — but over a slow link it caps you around 25 GB. Raise `read_body`
  if that ever bites.

---

## How retention and cleanup work

Every `cleanupIntervalMinutes` (and on demand from **Admin → Run cleanup now**) the server
sweeps:

1. Transfers past their expiry are marked **expired**.
2. If *delete-after-all-downloaded* is on, transfers every recipient has downloaded are
   marked **completed**.
3. Finished transfers release their hold on the underlying files.
4. A file whose last holder is gone is deleted from disk.
5. Uploads that finished but were never actually sent are deleted after
   `orphanUploadHours`.
6. Files on disk with no database record — the result of the server being killed
   mid-upload — are deleted after the same window.

So a transfer disappears at **whichever comes first**: the retention deadline, everyone
having downloaded it, the sender cancelling it, or an admin deleting it.

Because bulk sends share one copy of the bytes, a file is only removed once *every*
transfer referencing it is finished.

---

## Putting it on the internet

BetSend is a plain Node process with a SQLite file and a data directory, so a public
deployment is: **a small server, a DNS record, and a reverse proxy that terminates
HTTPS.** There is no container to build and no platform to sign up for.

Any VPS will do — the app is single-process and I/O bound, so 1–2 vCPUs and 2 GB of RAM
comfortably serve 150 people. What matters is **disk** (enough for everything in flight)
and **bandwidth** (people will be pushing gigabytes).

### 1. Point a name at the server

Create a DNS A record — `files.yourcompany.com` → the server's IP. Wait for it to
resolve before the next step; Caddy needs it to obtain a certificate.

### 2. Install BetSend

```bash
git clone <this-repo> /opt/betsend
cd /opt/betsend
sudo ./scripts/install.sh --public-url https://files.yourcompany.com --storage /srv/betsend
```

Passing `--public-url` changes three things versus a LAN install:

- `host` becomes `127.0.0.1`, so the app is unreachable except through the proxy — nobody
  can skip TLS by hitting port 8080 directly;
- `publicMode` turns on `Secure` cookies and HSTS;
- `behindProxy` makes rate limiting see the real visitor rather than the proxy.

It prints an admin token. Keep it.

### 3. Put Caddy in front

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/files.example.com/files.yourcompany.com/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate by itself. The supplied `Caddyfile` also raises
the body-size and timeout limits, which otherwise cut off multi-gigabyte transfers.

### 4. Firewall

Only 80 and 443 should be open. Port 8080 must **not** be:

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

### 5. Add your people

Open the site, go to **Admin**, enter the token, paste your staff list, and send each
person a setup link. Promote yourself with **Make admin** so you stop needing the token.

### What you are trusting

Worth being clear about, since this is now reachable from anywhere:

- **Files are not encrypted at rest.** Anyone with access to the server — you, your
  hosting provider, anyone who gets root — can read what is waiting on disk.
- **The admin token is a single shared secret.** Rate limited (5 tries per 15 minutes per
  IP), but still one string. Promote a real admin account and treat the token as a
  break-glass credential.
- **There is no email.** Password resets are links you distribute by hand. For 150 people
  that is fine; it does not scale past that.
- **Sessions last 30 days.** Shorten `sessionDays` if that is too long, and use **Sign out
  everywhere** in Admin when somebody loses a laptop.

### Keeping it patched

A public server is your responsibility to maintain:

```bash
cd /opt/betsend && git pull && sudo ./scripts/install.sh   # rebuild + restart
sudo apt update && sudo apt upgrade                        # the OS underneath
```

---

## How it runs in the background

`Install BetSend.bat` registers a **scheduled task** called `BetSend` that runs at startup
as `SYSTEM`, so BetSend is up before anyone logs in and stays up after they log out.

The task does not launch Node directly — it launches `scripts\supervise.ps1`, a small
wrapper that restarts the server whenever it exits and appends both output streams to
`logs\betsend.log` (rotated at 20 MB). Task Scheduler on its own only restarts a task that
*fails*; a process that exits cleanly would otherwise stay dead until someone noticed.
Repeated fast crashes back off from 5 seconds up to 5 minutes, so a bad port or an
unwritable storage directory cannot spin the CPU.

On Linux the equivalent is a systemd unit with `Restart=always`.

### Checking on it

```powershell
Get-ScheduledTask -TaskName BetSend         # is it registered?
Get-Content logs\betsend.log -Tail 40       # what has it been doing?
Restart-ScheduledTask -TaskName BetSend     # kick it
```

### Things worth getting right

- **Storage on a roomy drive.** `-StorageDir D:\BetSendData` at install time, or edit
  `storageDir` in `config.json` and restart. It must be a **local** path — the service
  runs as `SYSTEM`, which cannot see mapped network drives.
- **The machine must not sleep.** Check **Power Options → Sleep → Never**. A sleeping
  host is the most common cause of "BetSend is down".
- **Port 80 makes the address friendlier** (`http://192.168.1.40` instead of
  `…:8080`). Install with `-Port 80`. If IIS or another web server is already on 80, the
  installer warns you before it gets that far.

### A name instead of an IP address

`http://betsend` reads better than `http://192.168.1.40`, and it means the address in
everyone's bookmarks survives the server changing IP.

- **With a domain / office DNS server:** add an A record `betsend` → the server's IP.
- **On a small network:** give the machine a DHCP reservation on your router, then add a
  host entry there if it supports one.
- **Per machine, as a stopgap:** add `192.168.1.40  betsend` to
  `C:\Windows\System32\drivers\etc\hosts`.

Whichever you pick, install with `-Port 80` so nobody has to type a port number.

### Prefer NSSM?

If your organisation already standardises on [NSSM](https://nssm.cc/download), it works
just as well — point it at `node.exe` with `server\dist\index.js` as the argument and
your BetSend folder as the startup directory, and skip the scheduled task. The installer
is only there so nobody *has* to.

---

## Development

```bash
npm install
npm run seed     # ten fake colleagues to click around with
npm run dev      # API on :8080, Vite dev server on :5173
```

Open <http://localhost:5173> — the dev server proxies `/api` and `/ws` to the backend, so
hot reload works while the real server handles uploads.

Other scripts:

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run build`     | Builds the frontend into `server/public`, then compiles the server. |
| `npm start`         | Runs the compiled server (one process, one port).                   |
| `npm test`          | Runs the test suite (~10 seconds, no setup).                        |
| `npm run typecheck` | Type-checks both workspaces, tests included.                        |
| `npm run check`     | Typecheck + tests. What CI runs.                                     |
| `npm run seed`      | Adds the ten development users. Safe to re-run.                     |

### Tests

```bash
npm test                      # everything
npm run test:watch -w server  # re-run on save
```

110 tests on Node's built-in runner — no test framework to install. Each run gets a
throwaway SQLite database in a temp directory, so there is nothing to set up and
nothing to clean up.

| File                 | Covers                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `retention.test.ts`  | The sweeper and blob reference counting. The sharpest edge in the app: a bug here deletes somebody's files early or leaks disk forever, and neither is visible until a person complains. |
| `auth.test.ts`       | Every endpoint's behaviour signed out, sign-in, setup links, admin, and one colleague's access to another's transfer. |
| `uploads.test.ts`    | tus end to end against a real listening server: authentication, per-upload ownership, resume, quotas, ranged downloads, zips. |
| `sessions.test.ts`   | Expiry, revocation, and that neither cookies nor setup links are stored in the clear. |
| `passwords.test.ts`  | Hash/verify round trips and the strength rules.                      |
| `names.test.ts`      | `X.Lastname` parsing and staff-list import, including the CSV and CRLF a real paste contains. |

The suite is checked by mutation: deliberately removing the upload authentication
fails 6 tests, zeroing a reference count instead of decrementing it fails 1, and
ignoring the delete-after-download setting fails 1. A suite that never goes red is
not protecting anything, so it is worth re-checking that way after adding to it.

Layout:

```
server/   Fastify API, SQLite, tus upload endpoint, WebSocket hub, retention sweeper
web/      React + Vite + TypeScript + Tailwind frontend
```

---

## Architecture

**Data model** (SQLite, WAL mode):

| Table            | Holds                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `users`          | The directory: name, source (`self`/`admin`), last-seen time, active flag. |
| `blobs`          | One row per physical file on disk, with a reference count.                 |
| `transfers`      | One send action: sender, note, created/expiry time, state.                 |
| `transfer_files` | Which blobs belong to which transfer.                                      |
| `recipients`     | One row per person per transfer, with seen/downloaded timestamps.          |
| `uploads`        | In-flight tus uploads: owner and declared size, for access and quota.     |
| `sessions`       | Live sign-ins. Stores a hash of the cookie, never the cookie.              |
| `setup_tokens`   | One-time password links. Hashed too, and single use.                       |
| `settings`       | Admin overrides of the boot configuration.                                 |
| `events`         | A small audit trail.                                                       |

The fan-out lives in the shape of the schema: a bulk send writes one `blobs` row, one
`transfer_files` row per file and one `recipients` row per person. The bytes are written to
disk exactly once.

**Request flow for a send:** the browser PATCHes chunks to the tus endpoint, which appends
them straight to `<storageDir>/uploads/<id>`; when the last chunk lands, the browser POSTs
`/api/transfers` with the upload ids and recipient names, and the server writes the
metadata and pushes a WebSocket event to everyone addressed.

**Downloads** are streamed from disk with a real `Content-Length`, so the browser shows its
native progress bar, and `Range` requests are honoured so a download can be resumed.
Multi-file downloads are zipped on the fly (stored, not compressed) and streamed as they
are built — a 10 GB transfer never lands in RAM.

**Presence** is derived from live WebSocket connections, not a timestamp column, so the
green dot next to a name is accurate rather than approximate.

**Uploads are authenticated.** `/api/uploads` requires a session like every
other endpoint, enforced in a Fastify `preHandler` that runs *before* tus sees the
request — tus picks an id and creates the file early in its own POST handler, so a
check inside one of its hooks would already have let an anonymous caller write to
disk. Each upload records who started it, so one colleague cannot resume, inspect or
cancel another's transfer-in-progress even if they learn the id. Creation is also
refused when it would push free disk below `minFreeDiskBytes`, or the sender past
`perUserUploadBytes`.

**Identity is the work email address.** It is the unique key, the sign-in
credential and what the recipient picker matches on; the `X.Lastname` display name
is derived from it (`j.johnson@betlive.com` → `J.Johnson`) and only has to be
readable, so two people with the same name are told apart by their addresses rather
than being refused. Because only the office mail system can deliver to an allowed
domain, receiving a link at one is what proves somebody works here — which is why
there is no separate staff list to keep in step.

**Authentication.** Passwords are hashed with scrypt from Node's standard library — no
native module to compile, memory-hard enough that a stolen database is not a list of
passwords. Sign-in sets an `httpOnly` cookie holding a random token; the database stores
only its SHA-256, so a leaked backup cannot be replayed. Because it is a cookie rather
than a header, plain `<a>` download links carry it automatically — identity never appears
in a URL where it could reach a proxy log or a `Referer` header. Wrong-password and
unknown-name both return the same message after the same amount of work, so the sign-in
form cannot be used to discover who works here. Logins are rate limited per IP *and* per
name; the admin token per IP. Changing a password invalidates every other session.

### API

| Method | Path                                    | Purpose                                    |
| ------ | --------------------------------------- | ------------------------------------------ |
| GET    | `/api/bootstrap`                        | Server limits + remembered identity        |
| GET    | `/api/users?q=`                         | Directory for the recipient picker         |
| POST   | `/api/session`                          | Sign in with email + password              |
| POST   | `/api/register`                         | Ask for a sign-up link                     |
| POST   | `/api/password/forgot`                  | Ask for a reset link                       |
| DELETE | `/api/session`                          | Sign out                                   |
| GET    | `/api/setup/check`                      | Validate a setup link before showing a form |
| POST   | `/api/setup`                            | Set a first password from a link           |
| POST   | `/api/session/password`                 | Change your own password                   |
| POST/PATCH/HEAD | `/api/uploads/*`               | tus resumable upload endpoint              |
| POST   | `/api/transfers`                        | Commit finished uploads into a transfer    |
| GET    | `/api/inbox` · `/api/sent`              | Incoming / outgoing transfers              |
| POST   | `/api/transfers/:id/seen`               | Clear the unread badge                     |
| POST   | `/api/transfers/:id/revoke`             | Sender pulls a transfer back               |
| GET    | `/api/transfers/:id/files/:blobId`      | Stream one file (supports `Range`)         |
| GET    | `/api/transfers/:id/zip`                | Stream every file as a zip                 |
| GET/PUT| `/api/admin/settings`                   | Live configuration                         |
| GET    | `/api/admin/overview`                   | Storage, disk space, counts                |
| POST   | `/api/admin/users/import`               | Bulk import names                          |
| POST   | `/api/admin/users/:name/setup-link`     | Generate a one-time password link          |
| POST   | `/api/admin/users/:name/sign-out`       | Sign someone out of every device           |
| POST   | `/api/admin/users/:name/admin`          | Grant or revoke admin                      |
| PUT    | `/api/admin/users/:name/email`          | Set or correct somebody's address          |
| POST   | `/api/admin/mail/test`                  | Send a test message through the relay      |
| DELETE | `/api/admin/users/:name`                | Remove someone from the directory          |
| GET    | `/api/admin/transfers`                  | Every transfer on the server               |
| DELETE | `/api/admin/transfers/:id`              | Force-delete a transfer                    |
| POST   | `/api/admin/cleanup`                    | Run the retention sweep now                |
| WS     | `/ws?user=J.Johnson`                    | Notifications and presence                 |

---

## Troubleshooting

**Nobody else can open the page.**
It works on the server itself but not from other desks — almost always the firewall.
Re-run `Install BetSend.bat`, which adds the rule. Then check `host` is `0.0.0.0` (not
`127.0.0.1`) in `config.json`, and that colleagues are using the machine's IP rather than
`localhost`.

**It was working, now nothing responds.**
Check the machine is awake and the task is running:
`Get-ScheduledTask -TaskName BetSend`. Then read the tail of `logs\betsend.log` — the
supervisor records every exit and restart there with a timestamp.

**"BetSend: the web interface has not been built yet."**
The build did not finish. Re-run `Install BetSend.bat` (or `npm run build`) — the server
serves the compiled frontend from `server/public`.

**An upload stalled.**
It will resume by itself — tus retries with a backoff. If the tab was closed, re-adding the
same file continues from where it stopped rather than restarting.

**"The server is running out of space."**
Uploads stop being accepted once free space would drop below `minFreeDiskBytes`
(2 GiB by default), so the machine never wedges. Free some up, or lower the reserve.

**Disk is filling up.**
Admin shows what transfers are using versus what is free on the drive. Lower
`retentionHours`, leave *delete as soon as everyone has downloaded* on, or delete specific
transfers from the Admin table.

**Somebody forgot their password.**
They click *Forgotten it?* on the sign-in screen and a link is emailed to them. If mail
is not working, Admin → find them → **Reset link** still produces one you can hand over.

**Nobody is getting any email.**
Admin → Email → **Send a test message**. It reports what the relay actually said. The
usual cause is Exchange not permitting this machine's IP to relay.

**Somebody lost a laptop.**
Admin → find them → **Sign out everywhere**, then send a reset link. Their cookie stops
working immediately.

**"You need a setup link before you can create a password."**
Sign-up is invite-only — the default when `publicMode` is on. Generate a link in Admin.
On a LAN install you can switch **How people get a password** to self-service instead.

**Someone's name is wrong.**
Remove it in Admin and add the correct one, then send a setup link. Their existing
transfers are unaffected.

**The badge or the online dots look stale.**
That means the WebSocket dropped; the sidebar shows "Reconnecting to the server…" while it
retries. A page refresh forces it.

## Desktop app (Windows)

A BetSend window with its own icon, instead of a browser tab. It talks to the
same server — it is a second way in, not a replacement, and the web interface
keeps working for anyone who prefers it.

Download `BetSend-Desktop-Setup-*.exe` from the
[releases page](https://github.com/hellqimiclaude/BetSend/releases/latest) and
run it. It installs per-user, so local administrator rights are not needed.

On first run it asks for the server address — the computer name or IP of the PC
running BetSend, for example `betsend-pc` or `192.168.1.5:8080`. It remembers
it, and checks the address answers before saving, so a typo is caught there
rather than becoming a blank window. To point it somewhere else later, use
**Change server address** on the tray icon.

Closing the window leaves it in the tray so transfers can finish; **Quit
BetSend** on the tray menu exits properly. It starts with Windows by default,
which the tray menu can turn off.

### Building it

```
npm rebuild electron --no-ignore-scripts   # the repo .npmrc blocks install
npm run package -w desktop                 # scripts, Electron needs its runtime
```

The installer lands in `dist-desktop/`. CI builds it on every push and attaches
it to each release.

### The unsigned-publisher warning

Neither installer is code-signed, so every person who runs one sees:

> **Windows protected your PC** — Microsoft Defender SmartScreen prevented an
> unrecognised app from starting.

They click **More info**, then **Run anyway**. This is a deliberate choice: a
certificate that actually removes the warning straight away is an EV one, at
roughly $400–700 a year.

Two things make it easier to live with:

- **Publish the checksums.** Every release lists the SHA-256 of each installer,
  so anyone can confirm the file is the one CI built:
  `Get-FileHash .\BetSend-Desktop-Setup-1.1.2.exe -Algorithm SHA256`
- **Hand it out over the network, not the internet.** Put the installer on a
  shared folder or an intranet page. Windows marks files that arrive from the
  internet, and that mark is most of what SmartScreen reacts to; a file copied
  from a share usually installs without a word.

And the browser always works with no warning at all, so anybody who would
rather not click through it does not have to.
