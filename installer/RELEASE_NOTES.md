Windows installer. Download the `.exe` below and run it.

Windows will warn that it does not recognise the publisher — the installer is
not code-signed. Choose **More info**, then **Run anyway**.

The wizard asks for a port (8080 by default; use 80 to leave the port out of
the address) and a storage folder. It then installs BetSend as a startup task
and begins serving, so it is already running by the time the wizard closes.
The last page shows the address to share and the admin token.

To send mail through your Exchange relay, set `smtpHost` (and `smtpFrom`) in
`config.json` in the installation folder, restart the BetSend task, then use
Admin → Email → Send a test message.

This is a LAN tool. Do not port-forward it to the internet without putting
HTTPS in front of it first — see the README.
