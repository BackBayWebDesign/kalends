<p align="center"><img src="public/favicon.svg" width="72" alt=""></p>

# Kalends

A self-hosted wall calendar. Kalends merges Google and Microsoft calendars and any number
of iCal feeds into one dark,
full-screen view: a big clock and date, today's agenda, a 5-day forecast and a
multi-week month grid of colour-coded event bars. It reflows to any screen, from a
4K portrait wall display to a small landscape iframe on a dashboard.

*Kalends* (Latin *kalendae*) was the first day of the Roman month, and the root of
the word "calendar".

- **Google and Microsoft sign-in (optional):** connect any number of Google and
  Outlook.com / Microsoft 365 accounts and pick their calendars. Read-only access.
- **Any iCal feed:** TeamSnap, SportsEngine, GameChanger, school and league calendars,
  iCloud, Sonarr, Radarr, Nextcloud, public holiday feeds. `webcal://` links work.
- **One colour per calendar**, set in the browser along with the timezone, week start,
  grid size, refresh interval, clock style and weather location.
- **Weather** from [Open-Meteo](https://open-meteo.com): no API key, no account.
- **Photos (optional):** rotate images from URLs or a local folder in the top-left slot.
- **Embeddable:** no frame restrictions on the display page, so it works in an
  `<iframe>` (Homepage, Homarr, Home Assistant, Dashy).
- **Small:** one Node process, one dependency ([ical.js](https://github.com/kewisch/ical.js)),
  settings in SQLite (`node:sqlite`, built into Node 22.13+). ~60 MB RAM.

## Install

### Proxmox VE (LXC)

Not yet in the community-scripts collection. Run the scripts from this repository
on a PVE host (see [community-scripts/](community-scripts/)):

```bash
COMMUNITY_SCRIPTS_ROOT=/path/to/kalends/community-scripts bash /path/to/kalends/community-scripts/ct/kalends.sh
```

It creates a Debian 13 unprivileged container, installs Node 24 and Kalends from the
latest GitHub release, and starts the `kalends` service on port 3000. Run `update`
inside the container to upgrade.

### Anywhere with Node 22.13+

```bash
git clone https://github.com/BackBayWebDesign/kalends.git
cd kalends
npm ci --omit=dev
cp .env.example .env    # optional: PORT, HOST, DATA_DIR
npm start
```

Then open `http://<host>:3000`.

## First run

1. Open `http://<host>:3000/settings` and **create the admin password**. Until a
   password exists, anyone who can reach the page can set it, so do this right away.
2. Add your calendars. A *US Holidays* feed is added as an example.
3. Set the weather location (search by city or ZIP) and timezone, then **Save**.
   Open displays pick up changes within a minute.

The display page (`/`) needs no login. Calendar links are only returned to signed-in
settings pages; the display only gets event titles, times and colours.

### Where to find iCal links

| Source | Where |
| ------ | ----- |
| Google Calendar | calendar.google.com → ⚙ Settings → the calendar under *Settings for my calendars* → *Integrate calendar* → **Secret address in iCal format**. Repeat per calendar (and per Google account). |
| iCloud | Calendar app → share the calendar → *Public Calendar* → copy the `webcal://` link |
| Outlook / Microsoft 365 | Outlook on the web → Settings → Calendar → *Shared calendars* → *Publish a calendar* → ICS link |
| Sonarr / Radarr | *Calendar* → **iCal Link** (includes the API key) |

Treat secret links like passwords: anyone with the link can read that calendar.

## Google and Microsoft sign-in

Optional, and nothing to set up: in **Settings → Accounts** press **Sign in with
Google** or **Sign in with Microsoft**, sign in, then **Add calendars** next to the
account and **Save**. Sign in as many accounts as you like. Kalends can only read
calendars, and tokens stay in the SQLite database in `DATA_DIR`. They never reach the browser.

- **Microsoft** (Outlook.com, Hotmail, Live, Microsoft 365): Kalends shows a code.
  Open `microsoft.com/link` on any device, enter the code and sign in.
- **Google:** a Google tab opens. Sign in and allow access. Kalends' Google app isn't
  verified by Google yet, so Google warns about it: click **Advanced → Go to Kalends**.
  Google then sends the tab to an `http://127.0.0.1/…` address that doesn't load.
  That's expected: copy that address, paste it into Kalends and press **Connect**.
  (Google doesn't allow the code-on-screen method for calendars, and self-hosted apps
  have no fixed web address to return to, so the address is copied back by hand.)

Removing an account in Kalends removes its calendars and, for Google, revokes Kalends'
access. You can also remove it from your Google or Microsoft account's
security / app permissions page.

Work and school Microsoft accounts: some organisations block apps their admin hasn't
approved. Use the calendar's published ICS link instead.

### Using your own app registration

Kalends ships with its own app registrations, so this is only needed if you want your
own. Set these in `.env` (or `/opt/kalends.env` in the LXC) and restart:

| Variable | |
| -------- | - |
| `KALENDS_GOOGLE_CLIENT_ID`, `KALENDS_GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client of type **Desktop app**, Google Calendar API enabled, `calendar.readonly` scope, app published to *In production* (in *Testing*, sign-ins expire after 7 days) |
| `KALENDS_MICROSOFT_CLIENT_ID` | Entra app registration for any organisational directory + personal accounts, *Allow public client flows* = Yes, delegated Graph `Calendars.Read` + `offline_access` |
| `KALENDS_MICROSOFT_TENANT` | Default `common`; `consumers` for personal accounts only, or a tenant ID |

## Display options

Everything is set on the settings page. These URL parameters override it per screen,
which is handy when one Kalends feeds both a wall display and a dashboard iframe:

| Parameter | Values | Example |
| --------- | ------ | ------- |
| `layout` | `portrait`, `landscape` | `/?layout=landscape` |
| `weeks` | 1–8 | `/?weeks=3` |
| `mode` | `rolling`, `month` | `/?mode=month` |
| `scale` | text size, 0.5–2 | `/?scale=1.2` |
| `weather` | `0` hides it | `/?weather=0` |
| `photo` | `0` hides it | `/?photo=0` |

*Auto* layout picks portrait when the window is taller than it is wide.

### Photos

Turn on **Show photos** and either list image URLs, or copy images into
`DATA_DIR/photos/` (`/opt/kalends/data/photos/` in the LXC). They're served from
`/photos/<file>` and change on the interval you set.

## Configuration file

Only the server settings live in the environment (`.env`, or `/opt/kalends.env` in
the LXC):

| Variable | Default | |
| -------- | ------- | - |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite database (`kalends.db`) and `photos/` |

Back up `DATA_DIR` to keep your calendars and settings.

## API

| Endpoint | |
| -------- | - |
| `GET /api/display` | Public settings and calendar names/colours |
| `GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD` | Merged events (max 120 days) |
| `GET /api/weather` | Current conditions and 6-day forecast |
| `GET /api/health` | `{ ok, version }` |

## Development

```bash
npm install
npm run dev      # restarts on change
npm test         # iCal parsing and recurrence tests
```

## Roadmap

- CalDAV sources (Nextcloud, Fastmail, iCloud with an app password)
- Optional continuous bars for multi-day events across a week row

## License

MIT
