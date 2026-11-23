# Karaoke Queue

A self-hosted karaoke party app for your home network.

- Guests join a room by QR code or link, search YouTube from their phones, and queue songs.
- One **screen** (a TV browser, or a laptop on HDMI) plays the videos.
- Everything stays in sync live on every device.

---

## Starting the server

### Requirements
- **Node.js and npm.** Tested with Node.js 26.13 and npm 11.20.
- All devices (the computer, the TV and phones) on the **same Wi-Fi/LAN**.
- Internet access on the computer, for YouTube search and the `nip.io` hostname lookup.

### First-time setup
```bash
cd karaoke
npm install          # installs all three workspaces (shared, server, client)
```

### Development (live reload)
```bash
npm run dev
```
This starts two processes:

| Process | Port | Role |
|---|---|---|
| `server` | 3001 | API + Socket.IO (restarts on code changes via `tsx watch`) |
| `client` | 5173 | Vite dev server, listening on the LAN. Proxies `/api` and `/socket.io` to :3001 |

The server prints the address to share, for example:
```
karaoke server listening on http://localhost:3001
sharing as http://192-168-0-231.nip.io (YouTube blocks many videos on raw-IP pages)
data folder: C:\…\karaoke\data (play log, logs, settings, admin login)
admin: no password set yet. Sign in at /admin with Administrator / password; you'll be asked to choose a new one.
```
Open **`http://<that-name>:5173`** on any device, for example `http://192-168-0-231.nip.io:5173`. Opening `http://localhost:5173` also works; the page moves itself to that name automatically (see [Why the address is `…nip.io`](#why-the-address-is-192-168-x-xnipio)).

To run only one half: `npm run dev -w server` or `npm run dev -w client`.

### Production (one port)
```bash
npm run build        # builds the client into client/dist
npm start            # serves the API and the built client on port 3001
```
Then open `http://<shared-name>:3001`. Set `PORT` to use another port.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server port |
| `KARAOKE_HOST` | auto (`<ip>.nip.io`) | Hostname to share, if your network blocks nip.io/sslip.io (see below) |
| `KARAOKE_DATA_DIR` | `<repo>/data` | Where the play log, log files, performance history, settings and the admin login are kept |
| `KARAOKE_MAX_ROOMS` | `200` | Rooms the server keeps open at once; creating more answers 503 |
| `KARAOKE_ROOM_CREATE_PER_MIN` | `20` | Rooms one address may create per minute |
| `KARAOKE_CSP_ENFORCE` | unset (report-only) | Set to `1` to enforce the Content-Security-Policy instead of only reporting violations to the log |
| `CHROME_PATH` | standard install location | Only for `npm run smoke`: the Chrome executable to drive |
| `API_URL` | `http://localhost:3001` | Dev only: where Vite proxies the API |

On Windows PowerShell: `$env:PORT = "4000"; npm start`.

### Other commands
- `npm run typecheck`: type-checks the server and client.
- `npm run build`: production build of the client.
- `npm test`: server tests (each run starts a real server on a free port).
- `npm run smoke`: after `npm run build`, drives the built app in Chrome at phone width (needs Chrome installed; set `CHROME_PATH` if it is somewhere unusual).

### Troubleshooting startup
- **Phones can't connect:** allow Node.js through Windows Firewall on **private** networks, and make sure the phones are on the same Wi-Fi (not a guest network).
- **"Port already in use":** a previous server is still running. Stop it, or set `PORT`.
- **Many videos say "can't be played on this screen":** the page is open by IP or `localhost`. Use the `nip.io` address the server prints (below).

---
