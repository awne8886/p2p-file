# PizzaDrop

Send files of any size straight from your browser to someone else's. Drop a file, get a short link and a QR code, and
keep the tab open while they download. The file never touches a server: it streams peer-to-peer over an encrypted
WebRTC data channel, and each file is SHA-256 verified on arrival.

![PizzaDrop sender view](docs/screenshot-desktop.png)

<p align="center"><img src="docs/screenshot-mobile.png" alt="PizzaDrop on a phone" width="260"></p>

- **No size limit.** Both ends stream: the sender reads the file in 1 MiB slices and the receiver writes straight to
  disk. Memory stays flat. A 1 GB transfer was measured at a constant ~1.2 GB total across all headless Chrome
  processes, from start to finish.
- **Short links** like `https://pzza.app/x7k4q`: 5 characters from an alphabet with no `0/O/o`, `1/l/I/i`.
- **QR code** generated in the browser, standard polarity, error correction level Q. It encodes the plain `https://`
  link.
- **Many receivers at once**, each with its own connection, progress bar, speed and ETA.
- **Resumes** mid-file if a receiver's connection drops.
- **Multiple files** are sent one after another and zipped on the fly on the receiver's side.
- **Animated colour-ASCII pizza** on a pure black page, with a static version for `prefers-reduced-motion`.

---

## How it works

```
  Sender tab                     Signaling server (Node + ws)              Receiver tab
  ──────────                     ────────────────────────────              ────────────
  drop file
  {t:"host"}  ─────────────────▶ issues code "x7k4q"
  link + QR  ◀─────────────────  {t:"hosted"}
                                                         ◀──────────────── open /x7k4q  {t:"join"}
  {t:"peer-joined"} ◀──────────  introduces the peers
  offer / ICE ─────────────────▶ relays ──────────────────────────────────▶ answer / ICE
  ◀───────────────────────────── relays ◀────────────────────────────────── (both ways)

  ══════════════ RTCDataChannel — DTLS-encrypted, browser to browser ══════════════
  manifest (names, sizes) ──────────────────────────────────────────────▶ shows name, size, [Download]
  ◀─────────────────────────────────────────────────────────────────────── request(file 0, offset 0)
  64 KiB binary chunks ─────────────────────────────────────────────────▶ hash + write to disk
  ◀─────────────────────────────────────────────────────────────────────── ack(bytes written)  ← flow control
  file-end(sha256) ─────────────────────────────────────────────────────▶ compare → next file … → Done ✓
```

- The **signaling server** only issues codes and relays WebRTC session descriptions and ICE candidates. It never
  sees file contents, file names or sizes: the manifest travels over the data channel.
- A **code** lives until the sender stops sharing or closes the tab (released immediately on `pagehide`, or after a
  20 s grace period if the socket just drops). It also expires after 24 h without signaling activity. Codes are
  case-insensitive, and joins are rate-limited per IP so codes can't be enumerated.
- **Multiple files** are sent one after another, and the receiver zips them on the fly (STORE, zip64-capable) into a
  single `pizzadrop-<code>.zip`. Zipping happens on the receiver's side so every file can still be hashed and resumed
  individually, and so the zip's exact size is known up front.

## Tech choices

- **Vite + React + TypeScript** for the client. It's a single-page app with two routes (`/` and `/<code>`), so a
  static SPA fits better than an SSR framework like Next.js. Vite also handles the Web Workers and the fixed-name
  service worker build with no extra tooling. Runtime dependencies are `react`, `react-dom`, `@noble/hashes`
  (incremental SHA-256), `client-zip` (streaming zip) and `qrcode-generator`.
- **Node.js + `ws`** for the signaling server rather than a Cloudflare Worker + Durable Object. One small process
  serves the built client and the WebSocket on the same origin, with no vendor lock-in. It deploys as a single Docker
  image anywhere, and in-memory rooms are the simplest correct state for short-lived codes. The trade-off is that you
  run one instance: see [Known limits](#known-limits).

## Repository layout

```
shared/   wire protocol types + validators, short-code generator, formatting helpers
server/   signaling server: rooms & codes, rate limiting, ICE/TURN config, static hosting
client/   web app
  src/ascii/      ASCII pizza: illustration, renderer
  src/lib/        transfer engine: sender, receiver, back-pressure, hashing, save sinks, signaling
  src/sw/         service worker for streaming downloads
  src/workers/    SHA-256 worker, OPFS writer worker
  src/pages/      send + receive screens
e2e/      Playwright end-to-end tests (real browsers, real WebRTC)
scripts/  dev runner
```

## Local development

Requires **Node.js ≥ 22.12**.

```sh
npm install
npm run dev            # http://localhost:5173  (Vite; proxies /ws to the signaling server on :8080)
```

Open the page, drop a file, then open the link in another browser window (or a private window) to receive it. To try
it from a phone on the same network, run `npm run dev -- --host`. Some save paths (service worker, OPFS, File System
Access) need a secure context, so plain `http://<lan-ip>` falls back to in-memory downloads. Use an HTTPS tunnel to
test those.

| Script                     | What it does                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`              | shared (watch) + signaling server (tsx watch) + Vite dev server                |
| `npm run build`            | compile `shared` and `server`, bundle `client` into `client/dist`              |
| `npm start`                | production server on `$PORT` (default 8080), serving `client/dist` + `/ws`     |
| `npm run check`            | ESLint + Prettier check + typecheck (all packages, e2e, scripts) + unit tests  |
| `npm test`                 | Vitest unit tests (short codes, protocol validation, rooms, back-pressure…)    |
| `npm run test:e2e`         | build first; drives headless Chromium through every save path (see below)      |

The e2e suite starts the production server on a free port and runs real WebRTC transfers between browser contexts:
- QR decoding back to the link, and ≤ 15 stars
- every save path, each SHA-256 checked: in-memory, service worker, OPFS, and File System Access (with a stubbed
  picker)
- multi-file zip, including duplicate names and an empty file
- two simultaneous receivers
- a 256 MB transfer whose data channel is killed at 20% and resumes to a byte-identical file
- expired links
- the `beforeunload` prompt, and code release when the sender's tab closes
- static rendering under reduced motion
- mobile layout with no horizontal overflow

Set `CHROMIUM_PATH` to point at a Chromium binary and `E2E_BIG_MB` to change the large-file size.

## Deployment

The app needs **HTTPS** in production. Streaming saves, the clipboard API and the service worker all require a secure
context, and phones won't open camera-scanned `http://` links without a warning.

### Docker

```sh
docker build -t pizzadrop .
docker run -d -p 8080:8080 -e PUBLIC_URL=https://pzza.app pizzadrop
```

Or use the compose file, which includes an optional coturn TURN server:

```sh
cp .env.example .env               # edit PUBLIC_URL, TURN_* …
docker compose up -d               # app only
docker compose --profile turn up -d   # app + coturn
```

Put a TLS-terminating reverse proxy in front and make sure it forwards WebSocket upgrades on `/ws`. With Caddy:

```
pzza.app {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy proxies WebSockets automatically. With nginx, add `proxy_set_header Upgrade $http_upgrade;` and
`proxy_set_header Connection "upgrade";` for `/ws`. Set `TRUST_PROXY=true` so rate limiting sees real client IPs.

### One-click-ish hosts

Any Docker host with WebSocket support works. Keep it to **one instance** (rooms live in memory):

- **Fly.io:** `fly launch` (it detects the Dockerfile), set `internal_port = 8080`, then
  `fly secrets set PUBLIC_URL=https://<app>.fly.dev`, then `fly scale count 1`.
- **Render / Railway / Koyeb:** create a Docker web service from this repo, port `8080`, one instance, and set the
  env vars below.

Health check: `GET /healthz` → `{"ok":true,"rooms":…,"receivers":…}`.

## Environment variables

All optional. See [`.env.example`](.env.example).

| Variable                      | Default                                                    | Meaning                                                                          |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PORT` / `HOST`               | `8080` / `0.0.0.0`                                         | Listen address                                                                   |
| `PUBLIC_URL`                  | _(page origin)_                                            | Canonical origin for links/QR codes, e.g. `https://pzza.app`                     |
| `STATIC_DIR`                  | `client/dist`                                              | Built client to serve; empty = signaling only                                    |
| `CODE_LENGTH`                 | `5`                                                        | Share-code length (5–6); a crowded code space auto-extends to 6                  |
| `ROOM_IDLE_TTL_SECONDS`       | `86400`                                                    | A code expires after this long with no signaling activity                        |
| `HOST_GRACE_SECONDS`          | `20`                                                       | How long a code survives the sender's socket dropping (not a clean tab close)    |
| `MAX_PEERS_PER_ROOM`          | `32`                                                       | Concurrent receivers per code                                                    |
| `STUN_URLS`                   | `stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478` | Comma-separated STUN servers                                                   |
| `TURN_URLS`                   | _(none)_                                                   | Comma-separated TURN URLs, e.g. `turn:turn.pzza.app:3478?transport=udp`          |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | _(none)_                                             | Static TURN credentials                                                          |
| `TURN_SECRET`                 | _(none)_                                                   | coturn `static-auth-secret`: mint short-lived credentials per connection instead |
| `TURN_CREDENTIAL_TTL_SECONDS` | `86400`                                                    | Lifetime of minted TURN credentials                                              |
| `TRUST_PROXY`                 | `false`                                                    | Use `X-Forwarded-For` for rate limiting (only behind your own proxy)             |
| `ALLOWED_ORIGINS`             | _(any)_                                                    | Comma-separated Origins allowed to open `/ws`                                    |

### Adding a TURN server (coturn)

STUN is enough for most home and office networks. When **both** peers are behind symmetric NAT or strict firewalls
(some corporate networks, some mobile carriers), they can't connect directly. The receiver then sees *"Couldn't
connect to the sender directly…"*, and a TURN relay fixes it:

1. Run coturn on a host with a public IP. The `turn` compose profile does this: set `TURN_SECRET` (a long random
   string) and `TURN_EXTERNAL_IP` in `.env`, then open UDP/TCP 3478 and UDP 49160–49400.
2. Point the app at it: `TURN_URLS=turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp` and the same
   `TURN_SECRET`.
3. The server then hands each browser credentials that expire after `TURN_CREDENTIAL_TTL_SECONDS` (coturn's TURN REST
   API scheme), so nothing long-lived is exposed. The compose config also blocks relaying into private address
   ranges.

Relayed traffic still carries DTLS-encrypted data: the relay can't read the files, but it does carry their bandwidth.

## Browser support

Automated tests run on Chromium. For the other browsers, the save path listed below is the one this code selects
based on the APIs it detects; those browsers aren't exercised in CI yet.

| Browser                                   | Send | Receive: how the file is saved                                                                 |
| ----------------------------------------- | :--: | ---------------------------------------------------------------------------------------------- |
| Chrome / Edge / Opera desktop (102+)      |  ✓   | **File System Access**: save dialog, bytes written straight into the chosen file (tested)       |
| Chrome Android, Samsung Internet          |  ✓   | **Service-worker stream** into Downloads (the SW path is tested in Chromium)                    |
| Firefox desktop & Android (114+)          |  ✓   | **Service-worker stream** into Downloads                                                        |
| Safari macOS (15.4+, 16.4+ recommended)   |  ✓   | **OPFS**: streamed to a private on-disk file, then handed to Downloads (the OPFS path is tested in Chromium) |
| iOS / iPadOS, any browser (WebKit)        |  ✓\* | **OPFS**, as above                                                                             |
| Anything else with WebRTC                 |  ✓   | **In-memory Blob**: warns before downloads over 500 MB                                          |

\* iOS suspends background tabs, so an iPhone **sender** must keep PizzaDrop in the foreground.

Firefox private windows disable service workers and OPFS, so they fall back to in-memory downloads with the warning.
`?sink=memory|service-worker|opfs|file-system-access` on a receive link forces one path, which is handy for testing.

## Known limits

- **The sender's tab must stay open.** Closing it ends the share (the page warns first). Background tabs keep
  sending, except on iOS.
- **Resuming** works within a page session (network blips, ICE failures, a dropped data channel). A receiver that
  reloads the page starts over, because the partially written file belongs to the old page.
- **Throughput** is bounded by CPU (SCTP + DTLS + SHA-256) and the network. In the CPU-starved, GPU-less CI
  container, both browsers on one 4-vCPU box ran at about 13–22 MB/s. Real machines go faster, and LAN transfers are
  usually disk- or Wi-Fi-bound. Through a TURN relay you get the relay's bandwidth.
- **OPFS staging (Safari/iOS)** needs free disk space for the file and then briefly a second copy while the browser
  moves it to Downloads.
- **One server instance.** Rooms live in memory. Scaling out would need routing by code (sticky sessions) or a shared
  store such as Redis pub/sub.
- **Folders** can't be dropped directly. Zip them first, or select the files inside.
- **Zips are uncompressed** (STORE). Most large files are already compressed, and it keeps zipping streaming and
  cheap.
- **Trust model.** The SHA-256 check catches corruption and bugs. It can't catch a malicious sender, who controls
  both the file and the hash. As in any WebRTC app, the data channel's DTLS fingerprints travel via the signaling
  server, so you're trusting whoever runs that server not to swap them. Anyone with the link can download while the
  tab is open, so treat the link like the file.

---

## How it was built

### Streaming and back-pressure

**Sender.** Each receiver gets its own `RTCPeerConnection` and one ordered, reliable `RTCDataChannel`, so a slow or
dropped receiver can't affect the others. For each requested file, `streamBlob()` (`client/src/lib/flow.ts`) reads
the `File` in 1 MiB `slice().arrayBuffer()` blocks, prefetching exactly one block ahead. It sends each block as
64 KiB messages. Before every `send()` it checks two conditions:

1. **Local back-pressure:** `bufferedAmount ≤ 4 MiB`. Otherwise it waits for `bufferedamountlow`, which fires at
   1 MiB, with a 250 ms poll as a safety net. Chrome closes channels whose buffer passes 16 MiB, so this keeps a wide
   margin.
2. **End-to-end flow control:** no more than 16 MiB sent but not yet acknowledged by the receiver. WebRTC has no
   receive-side back-pressure, so without this a receiver with a slow disk would silently buffer the whole file in
   RAM. The receiver sends `ack(bytes written)` every 1 MiB as its sink *consumes* data, not as it arrives.

Unit tests pin all of these properties down with a fake channel and fake slow disks:
- `bufferedAmount` never exceeds high-water plus one chunk
- in-flight bytes never exceed the window plus one chunk
- at most one outstanding read
- byte-exact output, resume from an offset, prompt abort, and close handling

**Receiver.** Each file is a pull-based `ReadableStream` (`highWaterMark: 0`) fed from the data channel. Bytes are
handed over only when the sink asks for more, which is what drives the acks. A single file is piped straight into the
sink. Multiple files go through `client-zip`'s `makeZip` first, and the next file is only requested once the backlog
drops below half the window. Every chunk is also posted to a Web Worker running an incremental SHA-256
(`@noble/hashes`; WebCrypto can't hash incrementally). At each `file-end` the receiver compares that digest with the
one the sender announced. The sender fingerprints each file once, in its own worker, as soon as it's dropped. On a
mismatch the sink is aborted, so the File System Access swap file is discarded and the service-worker download fails,
and the UI says so.

**Resume.** Receivers keep a per-tab client id. If the channel drops, the receiver rejoins through signaling, the
sender recognises the id and replaces that receiver's connection, and the receiver re-requests the current file from
the exact byte offset it had received. The hash state and the sink simply continue.

### The receiver's fallback ladder (`client/src/lib/sinks.ts`)

1. **File System Access** (`showSaveFilePicker` → `createWritable()`). The user picks a location and bytes stream
   into it. Writes go to a swap file that's committed on close or discarded on abort.
2. **Service-worker stream.** The page registers a download with `/sw.js` over a `MessageChannel` and points a hidden
   iframe at `/__pizzadrop/dl/<id>`. The service worker answers with a `Response` whose body is a `ReadableStream`
   fed from the page, carrying `Content-Disposition: attachment` and an exact `Content-Length`, including the
   predicted zip size. The stream's `pull()` reports how much the browser's download manager has taken, and the page
   keeps at most 4 MiB ahead of that, so back-pressure reaches all the way from the disk to the WebRTC sender. A
   keep-alive ping stops Firefox from killing the worker mid-download. If the worker doesn't pick up the request
   within 6 s, the ladder moves on.
3. **OPFS**, used on WebKit, where service-worker downloads are unreliable. A worker writes chunks through a
   `FileSystemSyncAccessHandle`, then the finished, disk-backed `File` goes to the download manager via an object
   URL. Staged files older than an hour are cleaned up on later visits.
4. **In-memory Blob**, the last resort. The UI warns before downloads over 500 MB and asks for confirmation.

### The ASCII renderer (`client/src/ascii/`)

The look follows the reference screenshot supplied for this project:
- a grid of monospace glyphs whose rows ripple like fabric
- bright diagonal bands (`# % @`) sweeping across dimmer `+ * =` troughs
- soft glow on the brightest glyphs

The difference is that here the colours come from a pizza.

1. **Illustration.** `pizzaArt.ts` draws a flat, cartoon pizza slice with canvas paths: puffy crust, a sauce rim,
   cheese with drips and a shaded edge, pepperoni, and basil. It's drawn tip-up and rotated 45° clockwise, so the tip
   points upper-right and the crust sits lower-left.
2. **Layout and sampling** (once per resize). The slice is fitted to 52% of the smaller viewport side (58% on
   phones) and centred. A character grid of about 42 rows covers it. The illustration is rasterised at 4×6 samples
   per cell, and each cell stores its coverage and the nearest of 11 *materials* (cheese, pepperoni, crust…).
3. **Glyph atlas** (once per resize). Every glyph × material × 12 brightness levels is pre-drawn into offscreen
   canvases. Ordinary levels use tight sprites. The top levels get padded sprites with a baked-in glow. Each
   material's colour runs shadow → base → saturated highlight, plus a pale glint at the very top.
4. **Per frame.**
   - Every cell is displaced by two travelling sine waves, which gives the rippling rows.
   - A warped diagonal band field sets its brightness, and a slow term drifts the colours.
   - Brightness picks the colour level and the glyph from the density ramp `. : + * = # % @`.
   - Darker, more saturated materials (pepperoni, sauce, crust) are biased towards denser glyphs and get a brightness
     floor, so they never sink into a dark band.
   - A hashed per-cell flicker adds the occasional sparkle.
   - The frame is one `drawImage` per visible cell, snapped to whole device pixels.
5. **Behaviour.**
   - Everything outside the slice is `#000`, apart from 9–15 (never more than 15) dim, slowly twinkling stars. They're
     placed with rejection sampling, far apart and at least three cells away from the slice.
   - The animation pauses when the tab is hidden.
   - With `prefers-reduced-motion` it renders one static frame.
   - Dragging a file over the page makes the waves speed up and brighten a little. An active transfer does the same,
     more gently.
