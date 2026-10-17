**New in this release:** BetLive's colours and type throughout, **Send with
BetSend** in the Explorer right-click menu, and transfers that carry on when
the window is closed — and resume from where they stopped if the app or the
machine restarts.

Two separate downloads:

- **`BetSend-Setup-*.exe`** — the **server**. Install this on *one* office PC, the
  machine everybody will send files through. You only do this once.
- **`BetSend-Desktop-Setup-*.exe`** — the **desktop app**, for everybody else. It is
  the larger of the two, around 80 MB, because it carries its own browser engine. Optional:
  colleagues can just open the server's address in a browser instead.

### Windows will warn you, and that is expected

These installers are not code-signed, so Windows shows:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.

Click **More info**, then **Run anyway**. The warning means "nobody paid for a
certificate", not "this is dangerous". If you want to be sure the file is the
one built here, check its SHA-256 against the list at the bottom of these
notes:

```
Get-FileHash .\BetSend-Desktop-Setup-*.exe -Algorithm SHA256
```

**A way to avoid the warning entirely:** put the desktop installer on a shared
folder or an intranet page and have colleagues copy it from there. Files that
do not arrive from the internet are not marked as such, and SmartScreen
generally leaves them alone.

### Installing the server

The wizard asks for a port — 8080 by default, or use **80** so colleagues can
type just the computer name with no port after it — and a storage folder. It
then installs BetSend as a startup task and begins serving, so it is already
running when the wizard closes. The last page shows the address to share and
the **admin token**; keep that, it is how you reach the Admin page.

On a brand new server the first screen asks for that token and creates the
first account, which becomes the administrator.

### Installing the desktop app

Installs per user, so local administrator rights are not needed. On first run
it asks for the server's address — the computer name or IP, for example
`betsend-pc` or `192.168.1.5:8080`. It checks the address answers before
saving it.

### Mail

To let people register and reset their own passwords, and to tell recipients
that files are waiting, set `smtpHost` and `smtpFrom` in `config.json` in the
server's installation folder, restart the BetSend task, then use
**Admin → Email → Send a test message**.

### Please do not put this on the internet

It is a LAN tool. Do not port-forward it without putting HTTPS in front of it
first — see the README.
