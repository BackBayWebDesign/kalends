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

Optional. Instead of pasting a secret iCal link per calendar, connect the account once
and tick the calendars you want. You register your own (free) app with Google and/or
Microsoft, so no third party ever sees your calendars. Kalends only requests read access.

**Kalends needs an `https://` address.** Google and Microsoft only redirect back to
`https` (or `localhost`). Put Kalends behind a reverse proxy with a certificate, for
example `https://kalends.example.com` → `http://<kalends-ip>:3000` in Nginx Proxy
Manager, Caddy or Traefik. The name only has to resolve for the browser you sign in
with; it does not need to be reachable from the internet.

In Kalends: **Settings → Accounts → Sign-in setup**, enter that address as the
*Public URL* and **Save**. The redirect URIs to register appear underneath.

### Google

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project
   (for example *Kalends*).
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **Google Auth Platform → Branding**: app name *Kalends*, your email as support and
   developer contact. **Audience**: *External*.
4. **Audience → Publish app** so the status is **In production**. While an app is in
   *Testing*, Google expires its sign-ins after 7 days and the calendars stop updating.
   You don't need Google's verification for your own use; on sign-in Google warns that
   the app is unverified, and you continue with *Advanced → Go to Kalends*.
5. **Clients → Create client → Web application**. Under **Authorized redirect URIs**
   add `https://<your-kalends>/api/oauth/google/callback`. Create it, then copy the
   **Client ID** and **Client secret** into Kalends and **Save**.
6. Press **Connect Google**, sign in, then **Add calendars** next to the account.
   Repeat **Connect Google** for each Google account.

### Microsoft (Outlook.com, Hotmail, Microsoft 365)

1. Open [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New
   registration**. You need an Entra tenant; a free Azure account comes with one.
2. Name *Kalends*. Supported account types: **Accounts in any organizational directory
   and personal Microsoft accounts**. Redirect URI: platform **Web**,
   `https://<your-kalends>/api/oauth/microsoft/callback`. Register.
3. Copy the **Application (client) ID** from *Overview*.
4. **Certificates & secrets → New client secret**, then copy its **Value** (not the
   Secret ID). Secrets expire (24 months at most): set a reminder to make a new one and
   paste it into Kalends.
5. Optional: **API permissions → Add → Microsoft Graph → Delegated**: `Calendars.Read`,
   `User.Read`, `offline_access`. Kalends asks for these at sign-in anyway.
6. In Kalends, enter the client ID and secret and **Save**. Leave *Tenant* as `common`;
   use `consumers` for personal accounts only, or your tenant ID for one organisation.
7. Press **Connect Microsoft**, sign in, then **Add calendars**.

Removing an account in Kalends removes its calendars and, for Google, revokes
Kalends' access. Client secrets and sign-in tokens are kept in the SQLite database in
`DATA_DIR` and are never sent to the browser.

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
