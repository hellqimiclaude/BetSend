# BetSend

A self-hosted web app for sending large files between people on an office network.

One machine on the LAN runs the server. Everyone else opens `http://<server-ip>:8080` in a
browser — nothing to install, no accounts, no passwords. Drop files, pick who should get
them, press Send. The files sit on the server until the recipients download them or the
retention period runs out.

Transfers are **store-and-forward**: the sender and the recipient never need to be online
at the same time.

> ⚠️ **LAN only.** BetSend has no authentication, no HTTPS and no encryption at rest. It is
> designed for a trusted office network. **Do not port-forward it, do not expose it to the
> internet, and do not put it in a DMZ.** If people outside the office need files, use
> something built for that.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How people use it](#how-people-use-it)
- [Importing your staff list](#importing-your-staff-list)
- [Configuration](#configuration)
- [How retention and cleanup work](#how-retention-and-cleanup-work)
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

### Windows

1. Install **Node.js LTS** from <https://nodejs.org> (next, next, finish).
2. Put the BetSend folder somewhere permanent — `C:\BetSend` is fine.
3. Double-click **`Install BetSend.bat`** and approve the administrator prompt.

That is the whole setup. The installer builds the app, generates an admin token, opens
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

1. They open `http://<server-ip>:8080`.
2. On the first visit they choose their name — either typing it (`J.Johnson` format) or
   picking it from the imported list, depending on the mode you configured.
3. The choice is remembered in the browser, so they land straight on the Send screen every
   time after that. If someone else uses their machine, **Not you? Switch user** at the
   bottom of the sidebar clears it.

Names are always *first initial, dot, last name* — `J.Johnson`, `A.Williams`,
`S.O'Brien`. Capitalisation is normalised automatically, so `j.johnson` and `J.JOHNSON`
are the same person.

---

## Importing your staff list

Open **Admin** in the sidebar and enter your `adminToken`. In **User list → Import people**,
paste the names:

```
J.Johnson
M.Smith
A.Williams
```

CSV works too — the name is taken from the first column, and a `name` header row is
ignored:

```csv
name,department
J.Johnson,Finance
M.Smith,Legal
```

Blank lines and lines starting with `#` are skipped, duplicates are ignored, and anything
that does not match the `X.Lastname` pattern is reported back to you rather than silently
dropped. Re-importing the same list is safe.

### Locking the list down

By default anyone can type any name (`registrationMode: "open"`). Once your 150 names are
imported, switch **Who can pick a name** to *Only names on the imported list*
(`registrationMode: "list"`). New visitors then get a searchable picker instead of a text
box, and unknown names are refused.

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
| `logLevel`                 | `LOG_LEVEL`                | `info`     | `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                  |

`retentionHours`, `maxUploadSize`, `deleteAfterAllDownloaded` and `registrationMode` can
also be changed live from the Admin page — those edits are stored in the database and
override the file. `storageDir` can be edited there too, but only takes effect after a
restart.

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
| `npm run typecheck` | Type-checks both workspaces.                                        |
| `npm run seed`      | Adds the ten development users. Safe to re-run.                     |

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

### API

| Method | Path                                    | Purpose                                    |
| ------ | --------------------------------------- | ------------------------------------------ |
| GET    | `/api/bootstrap`                        | Server limits + remembered identity        |
| GET    | `/api/users?q=`                         | Directory for the recipient picker         |
| POST   | `/api/users/claim`                      | Claim an identity                          |
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

**Disk is filling up.**
Admin shows what transfers are using versus what is free on the drive. Lower
`retentionHours`, leave *delete as soon as everyone has downloaded* on, or delete specific
transfers from the Admin table.

**Someone's name is wrong.**
Remove it in Admin and have them pick again. Their existing transfers are unaffected.

**The badge or the online dots look stale.**
That means the WebSocket dropped; the sidebar shows "Reconnecting to the server…" while it
retries. A page refresh forces it.
