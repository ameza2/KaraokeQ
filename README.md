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
| `KARAOKE_ONE_ROOM_PER_DEVICE` | `1` (on) | A device (network address) is in one room at a time: joining a second room closes the first. `0` turns it off, for example to try two rooms from one computer |
| `KARAOKE_TRUST_PROXY` | `0` (none) | How many reverse proxies or tunnels sit in front of the server (usually `1`). Needed so each guest keeps their own address for limits and blocks; leave it unset on a home network |
| `KARAOKE_YT_BUDGET_PER_MIN` | `80` | YouTube result pages the server may fetch per minute, all guests together (one phone may use a quarter of it); past that, new searches answer "busy" while pages already loaded keep working |
| `KARAOKE_CSP_ENFORCE` | unset (report-only) | Set to `1` to enforce the Content-Security-Policy instead of only reporting violations to the log |
| `CHROME_PATH` | standard install location | Only for `npm run smoke`: the Chrome executable to drive |
| `API_URL` | `http://localhost:3001` | Dev only: where Vite proxies the API |

On Windows PowerShell: `$env:PORT = "4000"; npm start`.

### Other commands
- `npm run typecheck`: type-checks the server and client.
- `npm run build`: production build of the client.
- `npm test`: server tests (each run starts a real server on a free port).
- `npm run smoke`: after `npm run build`, drives the built app in Chrome at phone width (needs Chrome installed; set `CHROME_PATH` if it is somewhere unusual).
- `npm run stress`: pretend phones search, page and type against a server with a made-up YouTube (no network), and report how much reaches it. Takes a few minutes. Start the server yourself with `KARAOKE_FAKE_YOUTUBE=1` to try search without internet.

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
- **Host away:** once the host has been fully disconnected (every device) for 5 minutes, everyone else sees **Claim host**. The first person to tap it becomes host. A host who keeps a phone open keeps the role.
- **Hand-over:** ☰ → Make someone else host. The old host's saved link stops granting host, the new host stays host after a reload, and whoever loses host is told.
- **The screen** is whichever device plays the videos: a `/screen` page, or a phone/laptop using Play on this device.
- **One screen per room:**
  - Opening the screen somewhere else takes over. The old screen stops and shows "This screen was replaced".
  - The new one resumes the current song at the same position, and stays paused if the room is paused.

### Menu (☰)

| Section | Items |
|---|---|
| **Room** | Room history · Invite singers (QR code and link) · Change your name |
| **Settings** (host/screen) | **Everyone can control:** off by default; when on, everyone can skip, ⏮, seek, reorder and remove · **Fair queue:** on by default (see below) · **Room colour:** Orange, Blue, White or Green, on every device in the room |
| **Host & screen** (host/screen) | Make someone else host · Play on this device · Open the screen (always opens the shareable address) |

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
- YouTube search without an API key. Results are paged (10/25/50/100 per page) and the server sends one page at a time, up to 250 results per search. Videos that can't be embedded are flagged.
- **Paging:** ‹ Prev and Next move one page; « and » skip three. The label reads "76–100 of 103+": the plus means more can still be fetched. Changing "Per page" keeps the song you were looking at on screen.
- **Shared cache:** a search is remembered for 6 hours after it was last used, so guests looking for the same song cost YouTube nothing extra. All guests share a budget of YouTube requests (`KARAOKE_YT_BUDGET_PER_MIN`); when it runs out you see "Search is busy" and can still page through what is already loaded.
- **Autocomplete:**
  - ↓/↑ move through the suggestions (the highlighted one previews in the box) and Enter searches it.
  - The first Esc goes back to what you typed; the second closes the list.

### History and play log
- **Room history** (☰): the last 30 songs played, newest first, 10 per page with ‹ › buttons. **Replay** adds a song to the back of the queue, sung by you.
- **Play log:** every song played in every room is saved, whether finished or skipped:
  - **Files:** `data/rooms/<date>_<CODE>_<roomId>.jsonl`. The first line describes the room, then one line per song: video, title, singer, and when it was added and played.
  - **Viewing it:** the admin page (Rooms tab, **Show all** in a room's history). There is no public API for it.
  - **Notes:** a rewound song is logged again when it leaves the stage a second time. A room's file is deleted 30 days after its last song. `data/` is git-ignored and safe to delete.

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
- **Find a room:** the search box matches the room code, anyone in the room, and song titles (now playing or queued).
- **Sort** by session length, number of singers, or singers online, in either direction.
- Open a room for the full report:
  - Created time, last activity and songs played.
  - Screen address.
  - **Settings** as checkboxes you can change from here: Everyone can control, Fair queue, plus the room's colour.
  - Now playing, **users** (online or offline), the **queue**, and the **queue history**: the last 30 songs, with a button to load every song from the play log.
- **YouTube cast:** enter the TV's *Settings → Link with TV code* to cast a room to the TV's YouTube app, or **Stop casting**. A room that is already casting must stop first. The row also shows whether the cast is connected.
- **Make host** next to any singer assigns the host role. The new host and the previous host are both told.
- **+ Add room** creates a room; the first person to join becomes its host.
- **Delete room** (asks first) disconnects everyone and shows them "This room was closed by the admin". The play log and room log files are kept.

**Appearance tab**
- Colour presets: **Orange** (default), **Blue**, **White** and **Green**. White is a neutral monochrome look; the interface stays dark.
- The preset here changes the **admin pages only**, and is saved in `data/settings.json`.
- **Rooms have their own colour:** the host picks it in the room's menu (☰ → Settings → Room colour), and you can set it per room on the Rooms tab. The home and screen landing pages always use the default.

**Debug tab**
- **Server:** CPU, memory, system memory, uptime, connections, rooms, log size, Node version and the data folder. Refreshes every 3 seconds.
- **Performance over time:** line charts of CPU, memory, connections and rooms for the last 1 hour, 6 hours, 24 hours, 3 days or 7 days.
  - The server records one sample a minute and keeps 7 days, in `data/metrics/samples.jsonl`, so the history survives restarts.
  - Hover or tap a chart for the value at that time. A break in a line means the server was off.
  - "Show the numbers as a table" lists the same data.
- **Logs:** the system log or one room's log (including closed rooms), filtered by level, with a live view.
- **Verbose YouTube cast log:** a checkbox, off by default. When on, the log also records every command sent to the TV and every event it reports (very chatty; for debugging a cast). The setting is saved in `data/settings.json`.
- **Log files** are local files only, never a database:
  - `data/logs/server-YYYY-MM-DD.log` has every line, one file per day. The last 30 days are kept; older days are deleted automatically.
  - `data/logs/rooms/<CODE>.log` has one room's lines: created, joins, songs queued and played, host changes, settings, screen errors, closed. Each file holds at most 5 MB; when it's full, the oldest lines make room for new ones.
  - The play log (`data/rooms/`) keeps each room for 30 days after its last song.

**Account tab:** change the password.

### Rooms and state
- **What's in memory:** live rooms (queue, host, settings). Rooms expire after 6 idle hours, and **a server restart clears all live rooms**.
- **What survives a restart:** the files in `data/`: the play log, log files, performance history, the admin colour preset and the admin password. A room's colour is part of the room, so it's lost with it.

---

## Why the address is `192-168-x-x.nip.io`

YouTube refuses many videos (music labels especially: "uploader blocked embedding", error 150) when the page is opened by a raw IP address like `http://192.168.0.5:5173`, or by `localhost`. The same videos play when the page is opened by a hostname that points to the same computer. So:

- **Hostname:** at startup the server picks a name that resolves to its LAN IP: `192-168-0-5.nip.io`, or `sslip.io` as a backup.
  - These are free public DNS services that return the IP written in the name.
  - Only the private LAN IP is part of the lookup.
- **Shared links:** QR codes, invite links, the "Open the screen" menu item and the on-screen hints all use that name.
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
  src/index.ts            wiring: Express, Socket.IO, logging, metrics
  src/http/               public HTTP API and the built-client fallback
  src/sockets/            socket handlers by area (room, queue, playback, host, screen)
  src/rooms/              Room (queue, fair ordering, permissions, playback clock), registry, YouTube cast, embed-block rules
  src/search.ts           youtubei.js search + suggestions (no API quota), caching, rate limit
  src/net.ts              LAN IP + shareable hostname (nip.io / sslip.io)
  src/playLog.ts          play log (PlayLog interface + JSON-lines file store)
  src/logger.ts           log files: captures console output; system + per-room logs
  src/siteSettings.ts     admin-page settings (its colour preset)
  src/metrics.ts          performance history: one sample a minute, 7 days
  src/admin/              admin login (scrypt credential file) and the /api/admin routes
  src/playback/           PlaybackOutput interface; ScreenOutput (browser screen); LoungeOutput (YouTube cast)
  test/                   socket integration tests (npm test)
client/   React + Vite
  src/features/           one folder per area: home, screen, room, search, admin
  src/components/ui/      shared Sheet, Dialog and ToggleItem
  src/lib/                socket hook, storage, URLs, colour preset (theme.ts)
  src/styles/             CSS split by area; index.css sets the load order
data/     runtime files, git-ignored: rooms/ (play log), logs/, metrics/, admin/ (login), settings.json
```

## Next steps

Planned work:
1. YouTube cast: more testing on real TVs.
2. Refactoring and a test suite.
3. Source control: a remote and branching conventions.

## License

[MIT](LICENSE). This project is not affiliated with or endorsed by YouTube or Google. It uses YouTube's public player and an unofficial search and cast protocol, so follow YouTube's terms of service when you use it.
