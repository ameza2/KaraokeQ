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
| `KARAOKE_DATA_DIR` | `<repo>/data` | Where the play log, log files, site settings and the admin login are kept |
| `API_URL` | `http://localhost:3001` | Dev only: where Vite proxies the API |

On Windows PowerShell: `$env:PORT = "4000"; npm start`.

### Other commands
- `npm run typecheck`: type-checks the server and client.
- `npm run build`: production build of the client.

### Troubleshooting startup
- **Phones can't connect:** allow Node.js through Windows Firewall on **private** networks, and make sure the phones are on the same Wi-Fi (not a guest network).
- **"Port already in use":** a previous server is still running. Stop it, or set `PORT`.
- **Many videos say "can't be played on this screen":** the page is open by IP or `localhost`. Use the `nip.io` address the server prints (below).

---

## Using it

### The two landing pages
- **Default (`/`), for phones:**
  - **Start a party** (you become the host) or join with a code.
  - Videos don't play on this device unless the host turns it on (☰ → Play on this device).
- **Screen (`/screen`), for the TV or a laptop on HDMI:**
  - **Create a session** or join one by code. The last code is pre-filled but never joined automatically.
  - Either way, this device becomes the room's **screen**. It plays the videos full screen and shows the QR code while the queue is empty.
  - Exit full screen (✕ or Esc) to see the room page with all the controls; ⛶ goes back to full screen.
  - Opening `/r/CODE/screen` directly does the same.
- **Guests** scan the QR code or tap **Invite** to get the link.

### Full-screen controls (screen)
- A YouTube-style bar (seek bar, ±10s, ⏮, play/pause, ⏭, exit) fades after 3s without input. Any mouse move, tap or key brings it back, and it stays up while paused.
- Click the video to pause or resume. On touch, the first tap only shows the bar.
- **Keys:** Space/K pause, ←/→ or J/L ±10s, Shift+N skip, Shift+P back.
- **First song:** browsers block autoplay, so the very first song needs one click or tap on the screen.

### Host, screen and permissions

| Who | Can do |
|---|---|
| Anyone | Search and queue songs, pause/resume, see the room history, replay a song |
| The singer | Remove their own songs; skip while they're singing |
| **Host** | Skip, ⏮, seek, reorder, remove any song, settings, hand host to someone else |
| **Screen** (superhost) | Everything the host can do. It keeps these powers even after handing host away, and can move host from one person to another |

- **First host:** a room without a host gives host to the first person who joins. The creator's saved link always reclaims it.
- **Hand-over:** ☰ → Make someone else host. The old host's saved link stops granting host, the new host stays host after a reload, and whoever loses host is told.
- **The screen** is whichever device plays the videos: a `/screen` page, or a phone/laptop using Play on this device.
- **One screen per room:**
  - Opening the screen somewhere else takes over. The old screen stops and shows "This screen was replaced".
  - The new one resumes the current song at the same position, and stays paused if the room is paused.

### Menu (☰)

| Section | Items |
|---|---|
| **Room** | Room history · Invite singers (QR code and link) · Change your name |
| **Settings** (host/screen) | **Everyone can control:** off by default; when on, everyone can skip, ⏮, seek, reorder and remove · **Fair queue:** on by default (see below) |
| **Host & screen** (host/screen) | Make someone else host · Play on this device · Open TV screen (always opens the shareable address) |

### Queue rules
- **Fair queue** (on by default): each singer's Nth song plays after everyone else's Nth song, so people with fewer songs go first. The person singing counts as having used their turn.
  - Turn it off to play songs in the order they were added.
  - Switching only affects songs added afterwards.
- **Limits:** each singer can queue up to 5 songs, and duplicate videos are rejected.
- **Reordering** (host/screen, or everyone when allowed):
  - Drag a song by its ⠿ grip (mouse or touch). The list scrolls near the edges.
  - Or use the ▲/▼ buttons, which suit TV remotes and click-only devices.
  - Or focus the grip and press ↑/↓.
- **⏮:** more than 5s into a song it restarts the song. Otherwise it goes back to the previous song and puts the current one back at the front of the queue (one song back only).
- **Skipping the last song** ends it and leaves the room idle until someone queues another.

### Search
- YouTube search without an API key. Results are paged (10/25/50/100 per page), and videos that can't be embedded are flagged.
- **Autocomplete:**
  - ↓/↑ move through the suggestions (the highlighted one previews in the box) and Enter searches it.
  - The first Esc goes back to what you typed; the second closes the list.

### History and play log
- **Room history** (☰): the last 30 songs played, newest first, 10 per page with ‹ › buttons. **Replay** adds a song to the back of the queue, sung by you.
- **Play log:** every song played in every room is saved, whether finished or skipped:
  - **Files:** `data/rooms/<date>_<CODE>_<roomId>.jsonl`. The first line describes the room, then one line per song: video, title, singer, and when it was added and played.
  - **API:** `GET /api/rooms/<CODE>/plays` returns a live room's full list.
  - **Notes:** a rewound song is logged again when it leaves the stage a second time. `data/` is git-ignored and safe to delete.

### Admin area (`/admin`)

Open `http://<shared-name>:5173/admin` (or the **Admin** link at the bottom of the home page).

**Signing in**
- **First time:** username `Administrator`, password `password`. You must choose a new password (8 characters or more) before anything else is available.
- **Storage:** the password is never stored. Only a salted scrypt hash is kept, in `data/admin/credentials.json`.
- **Forgot the password?** Delete `data/admin/credentials.json` on the server. The login goes back to the default, which must be changed again.
- **Sessions** last 12 hours and end when the server restarts. Sign-in attempts are limited to 8 per minute per address.
- **Network:** the admin page works from any device on the LAN. The app uses plain HTTP, so only use it on a Wi-Fi network you trust.

**Rooms tab**
- Every live room with its **running time**, host, people online, queue length and screen status. Refreshes every 3 seconds.
- Open a room for the full report:
  - Created time, last activity and songs played.
  - Screen address and the room's settings.
  - Now playing, **users** (online or offline), the **queue**, and the **queue history**: the last 30 songs, with a button to load every song from the play log.
- **Make host** next to any singer assigns the host role. The new host and the previous host are both told.
- **+ Add room** creates a room; the first person to join becomes its host.
- **Delete room** (asks first) disconnects everyone and shows them "This room was closed by the admin". The play log and room log files are kept.

**Appearance tab**
- Colour presets: **Orange** (default), **Blue**, **White** and **Green**. White is a neutral monochrome look; the interface stays dark.
- The preset applies to every room and device, switches live on open pages, and is saved in `data/settings.json`.

**Debug tab**
- **Server:** CPU, memory, system memory, uptime, connections, rooms, log size, Node version and the data folder. Refreshes every 3 seconds.
- **Logs:** the system log or one room's log (including closed rooms), filtered by level, with a live view.
- **Log files** are local files only, never a database:
  - `data/logs/server.log` has every line.
  - `data/logs/rooms/<CODE>.log` has one room's lines: created, joins, songs queued and played, host changes, settings, screen errors, closed.
  - Each file rotates to `<name>.1` at 5 MB.

**Account tab:** change the password.

### Rooms and state
- **What's in memory:** live rooms (queue, host, settings). Rooms expire after 6 idle hours, and **a server restart clears all live rooms**.
- **What survives a restart:** the files in `data/`: the play log, log files, the colour preset and the admin password.

---

## Why the address is `192-168-x-x.nip.io`

YouTube refuses many videos (music labels especially: "uploader blocked embedding", error 150) when the page is opened by a raw IP address like `http://192.168.0.5:5173`, or by `localhost`. The same videos play when the page is opened by a hostname that points to the same computer. So:

- **Hostname:** at startup the server picks a name that resolves to its LAN IP: `192-168-0-5.nip.io`, or `sslip.io` as a backup.
  - These are free public DNS services that return the IP written in the name.
  - Only the private LAN IP is part of the lookup.
- **Shared links:** QR codes, invite links, the "Open TV screen" menu item and the on-screen hints all use that name.
- **Pages opened by IP or `localhost`** move themselves to the hostname, carrying your name, songs and host status. They only do this if the device can reach the hostname.
- **A screen still on an IP address or `localhost`:** if YouTube blocks the current video there:
  - The song is held, not skipped, and the video isn't marked as blocked.
  - The screen offers **Reopen at <name>** (the song continues there) or **Skip song**.
  - The host and the singer are told.
- **A screen that keeps failing:** if the same screen is blocked on two songs in a row with nothing playing in between, the screen is the problem. The song is held and the earlier song isn't marked as blocked.
- **The uploader really blocked it:** only a block on a hostname page, for a video that hasn't played anywhere else in the room, counts as the uploader's choice. That song is skipped and the singer gets a notice.
- **If your router blocks those names** (DNS rebind protection) or there's no internet DNS:
  - Set `KARAOKE_HOST` to a name your network resolves, for example a router DHCP name or `mypc.local`.
  - Otherwise the app falls back to the IP, and some videos will be held as blocked.

---

## Project layout

```
shared/   types shared by server and client (socket events, RoomState, QueueItem)
server/   Express + Socket.IO
  src/index.ts            HTTP routes and socket handlers (permission checks)
  src/rooms.ts            rooms: queue, fair ordering, host/screen permissions, playback clock, history
  src/search.ts           youtubei.js search + suggestions (no API quota), caching, rate limit
  src/net.ts              LAN IP + shareable hostname (nip.io / sslip.io)
  src/playLog.ts          play log (PlayLog interface + JSON-lines file store)
  src/logger.ts           log files: captures console output; system + per-room logs
  src/siteSettings.ts     site-wide settings (colour preset)
  src/admin/              admin login (scrypt credential file) and the /api/admin routes
  src/playback/           PlaybackOutput interface; ScreenOutput (browser screen); LoungeOutput (stub)
client/   React + Vite
  src/pages/Home.tsx      default landing: start / join
  src/pages/Screen.tsx    screen landing: create / join as the screen
  src/pages/Room.tsx      room page: now playing, controls, queue, menu
  src/pages/Search.tsx    search + autocomplete
  src/pages/Admin.tsx     admin area: sign-in, rooms, appearance, debug, account
  src/lib/theme.ts        applies the site colour preset
  src/components/ScreenPlayer.tsx  YouTube player, full screen + controls
data/     runtime files, git-ignored: rooms/ (play log), logs/, admin/ (login), settings.json
```

## Next steps

Planned work:
1. YouTube TV casting.
2. Refactoring and a test suite.
3. Source control: a remote and branching conventions.
