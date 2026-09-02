# A snapshot a day, without remembering to take one

`tools/build.js` reads Anki, the trainers' live browser storage, and any exports
lying in the usual folders, and folds all of it into `~/training-archive.json`.
Run daily, the cost of clearing site data drops from *the record* to *today*.

## Enable it

```bash
mkdir -p ~/.config/systemd/user
cp ~/training-archive/tools/daily/training-archive.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now training-archive.timer
```

Check it:

```bash
systemctl --user list-timers training-archive.timer
journalctl --user -u training-archive.service -n 30
```

To stop: `systemctl --user disable --now training-archive.timer`.

## Two things worth knowing

**Firefox must not be running with the profile locked for a *write*, but a read
is fine** — `firefox-storage.py` copies `data.sqlite` before opening it and
never touches the original. A snapshot taken mid-session simply catches the
session so far.

**Enable lingering if you want it to run while logged out**:

```bash
loginctl enable-linger "$USER"
```

Without it, user timers only run while you have a session. For a machine you
log into daily that is usually fine, and it is one fewer permission granted.
