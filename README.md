# ring-intercom-auto-unlock

> Automatically unlock your door or gate when someone rings your **Ring Intercom** — a lightweight, self-hosted Node.js service. **No Home Assistant or Homebridge required.**

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blue.svg)

🌍 [Italiano](README.it.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Nederlands](README.nl.md)

Perfect for shops, offices, B&Bs and anyone who wants the front door or gate to open by itself during business hours — without picking up the phone every time the buzzer rings.

## Features

- 🔔 **Listens for ding events** in real time via Ring push notifications
- 🏠 **Multiple intercoms** — configure each device separately in `devices.json`
- ⏱️ **Per-device random delay** before unlocking so it feels like a human buzzed you in
- 📅 **Per-device schedule** — weekly days/hours plus optional one-off `activeWindows` that force unlock on even outside the weekly rules
- 🔁 **Per-device cooldown** so a double ring doesn't open the door twice
- 🔢 **Optional press pattern** — exact N rings within T seconds (`pressWindowPresses` / `pressWindowSeconds`; omit or `0` to disable)
- ✅ **Enable/disable** individual devices without removing them from the config
- 🔑 **Automatic refresh-token rotation** — authenticate once, runs forever
- 📝 **Detailed logging** with `info`/`debug` levels, heartbeat, offline and low-battery warnings
- 🐳 **Docker-ready** — runs on any NAS (Synology/QNAP), VPS, Raspberry Pi or free-tier cloud VM
- 🪶 **Tiny**: one main file, two dependencies, ~100 MB of RAM

## What you need

- A [Ring Intercom](https://www.amazon.it/s?k=ring+intercom) (~€60, audio version is enough) installed on your existing intercom system
- Somewhere to run the service 24/7 — any of:
  - your NAS or a Raspberry Pi you already own
  - a free [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) VM
  - a small VPS: [Hetzner Cloud](https://www.hetzner.com/cloud) (~€4/month) or [DigitalOcean](https://www.digitalocean.com)

## How it works

```
Ring Intercom  ──ding──▶  this service  ──wait (per device)──▶  unlock()  ──▶  door opens
                            │
                            └── ignores the ring if that device is outside its schedule
```

The service uses the excellent [ring-client-api](https://github.com/dgreif/ring) to subscribe to your intercom's push notifications. When someone rings during that device's configured time window, it waits a random delay and sends the same unlock command the Ring app uses.

A ding on one intercom only unlocks **that** intercom — never another location on the same account.

## Quick start

Requires Node.js 20+ and a Ring Intercom already set up in the Ring app.

```sh
git clone https://github.com/tobijat/ring-intercom-auto-unlock.git
cd ring-intercom-auto-unlock
npm install

# 1. Get a Ring refresh token (asks for email, password and 2FA code)
npx ring-auth-cli

# 2. Auth + logging
cp .env.example .env
#    paste the token into RING_REFRESH_TOKEN=...

# 3. Per-device config (required)
cp devices.json.example devices.json
#    set each intercom's id, schedule, delay, and cooldown (see below)

# 4. Run
npm start
```

### Finding your intercom ids

`devices.json` is **required** before the service will start. To discover ids:

1. Copy `devices.json.example` → `devices.json` (placeholder ids are fine for the first run)
2. Run `npm start` once — the log lists every intercom: `Intercom found: "…" (id …)`
3. Put the real ids into `devices.json`, set `enabled` / schedules, and restart

Ring the buzzer: you should see `DING` in the log and, a few seconds later, `GATE OPENED`.

## Deploy with Docker (recommended)

Ensure both `.env` and `devices.json` exist next to `docker-compose.yml`, then:

```sh
docker compose up -d --build
docker compose logs -f
```

Works on Synology (Container Manager), QNAP (Container Station), any VPS, or a free [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) VM.

> **Important:** the `.env` file is mounted as a **writable** volume. Ring rotates the refresh token periodically and the service saves the new one there. Don't redeploy from an old copy of `.env` — the old token will have been invalidated.
>
> `devices.json` is mounted read-only. Edit it on the host and restart the container to apply changes.

## Configuration

### `.env` (auth + logging only)

| Variable             | Default | Description                                            |
| -------------------- | ------- | ------------------------------------------------------ |
| `RING_REFRESH_TOKEN` | —       | Ring auth token (get it with `npx ring-auth-cli`)      |
| `LOG_LEVEL`          | `info`  | `info` or `debug` (adds ring-client-api internal logs) |
| `HEARTBEAT_MINUTES`  | `60`    | Log an "I'm alive" line every N minutes (`0` = never)  |
| `LOG_FILE`           | `0`     | Keep `auto-unlock.log` for N days (`0` = file logging off). Newest entries at the top; older than N days are dropped |

### `devices.json` (per intercom configuration)

Copy from [`devices.json.example`](devices.json.example). Only **enabled** devices that match a Ring intercom id are enrolled.

| Field              | Required | Description |
| ------------------ | -------- | ----------- |
| `name`             | no       | Label for logs (does not have to match the Ring app name) |
| `id`               | yes      | Numeric Ring intercom id from the startup log |
| `enabled`          | no       | `true` (default) or `false` to skip without deleting the entry |
| `activeDays`       | yes      | Days `1`–`7` (1 = Monday … 7 = Sunday), comma-separated. Use `""` for no weekly days |
| `activeHours`      | yes      | Hour ranges, start inclusive / end exclusive — e.g. `8-20` or `8-12,13-20`. Use `""` for no weekly hours |
| `timezone`         | yes      | IANA timezone for weekly schedule **and** `activeWindows` (e.g. `Europe/Berlin`) |
| `minDelaySeconds`  | yes      | Minimum delay before unlock |
| `maxDelaySeconds`  | yes      | Maximum delay before unlock |
| `cooldownSeconds`  | yes      | Ignore further dings for N seconds after an unlock attempt |
| `activeWindows`    | no       | Extra one-off active periods (see below). Omit or `[]` if unused |
| `pressWindowPresses` | no     | Exact ding count required (`0` or omit = pattern off) |
| `pressWindowSeconds` | no     | Seconds after the first ding to evaluate the count (`0` or omit = pattern off) |

**When is auto-unlock active?** If the weekly schedule matches **or** the current time falls inside any `activeWindows` entry. Those windows force the device **on** even outside `activeDays` / `activeHours`. The weekly schedule still applies when you are not inside a window.

Empty `"activeDays": ""` or `"activeHours": ""` disables that part of the weekly schedule (so the weekly rule never matches). If both the weekly schedule is disabled and `activeWindows` is empty/missing, the service starts anyway but logs a **warning** — dings will be ignored until you add a schedule or window.

**`activeWindows`:** each entry is `{ "start": "YYYY-MM-DD HH:mm", "end": "YYYY-MM-DD HH:mm" }` in that device's `timezone`. Start is inclusive, end is exclusive (same idea as `activeHours`). Example: `"end": "2026-11-17 10:05"` means active until 10:05:00, not including that instant.

**Press pattern (optional):** with `"pressWindowPresses": 3` and `"pressWindowSeconds": 10`, the first ding starts a 10s window. When that window ends, unlock runs only if the count is **exactly** 3 — not 1, 2, 4, …. Omit both keys, or set either to `0`, to disable the pattern (every ding unlocks, after delay/cooldown). Both must be `> 0` to enable. The weekly schedule / `activeWindows` still apply: presses outside an active time are ignored, and a matched pattern will not unlock if the active period has already ended.

Example:

```json
[
  {
    "name": "Apartment A",
    "id": 111111111,
    "enabled": true,
    "activeDays": "1,2,3,4,5",
    "activeHours": "8-20",
    "timezone": "Europe/Berlin",
    "minDelaySeconds": 5,
    "maxDelaySeconds": 20,
    "cooldownSeconds": 60,
    "pressWindowPresses": 3,
    "pressWindowSeconds": 10,
    "activeWindows": [
      { "start": "2026-11-16 18:52", "end": "2026-11-17 10:05" },
      { "start": "2026-12-10 16:30", "end": "2026-12-18 05:45" }
    ]
  }
]
```

Schedule time comes from the **host clock** (PC/NAS), interpreted in each device's `timezone` — not from Ring cloud or the intercom itself. Restart the service after editing `.env` or `devices.json`.

## FAQ

**Does it work with the audio-only Ring Intercom?**
Yes — it's what this project was built on. Video models exposed as intercom handsets work too.

**Do I need a Ring subscription?**
No. Unlocking doesn't require a Ring Protect plan.

**The first run logs** `PHONE_REGISTRATION_ERROR`**.**
Harmless — push registration retries and succeeds on the second attempt. It only happens on a fresh token.

**Why a random delay instead of opening instantly?**
An instant unlock makes it obvious a bot opened the door. A short human-like delay also gives you time to glance at who rang, if you keep notifications on.

**Does my PC/NAS need an open inbound port?**
No. The service only makes outbound connections to Ring and to Google FCM for push notifications (notably TCP 5228 to `mtalk.google.com`).

**Is this safe?**
Understand what you're enabling: during a device's active window the door opens for **anyone** who rings that intercom, with no confirmation. Use schedules and `enabled` to limit exposure, and only use this where an unattended open door is acceptable.

## Security

The refresh token in `.env` grants full access to your Ring account — never commit it (it's in `.gitignore`) and be careful where you host the service. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Support this project

If this saved you from answering the buzzer fifty times a day:

- ⭐ Star the repo — it helps others find it
- ☕ [Buy me a coffee](https://buymeacoffee.com/mzat.dev)

## Contributing

Issues and pull requests are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an **unofficial** project, not affiliated with, endorsed by, or connected to Ring LLC or Amazon. It relies on the unofficial Ring API via [ring-client-api](https://github.com/dgreif/ring); Ring may change or break that API at any time. Automatic unlocking is done **at your own risk** — the authors accept no liability for unauthorized access, property loss or damage resulting from the use of this software.

## License

[MIT](LICENSE)
