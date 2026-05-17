# Return Facebook Share Viewer

Restores the "who shared your post" feature on your own Facebook profile, which Facebook silently removed in late 2025.

Re-enables the 'who shared your post' feature on your Facebook website.

## Install

1. Open `chrome://extensions/`
2. Toggle on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

Then visit your own Facebook profile and scroll. For each post that has shares (count > 0), a `N shares` link will appear below the like/comment/share row.

- **Hover** the link → small tooltip with the first few sharers' names
- **Click** the link → modal listing all visible sharers, with avatars, timestamps, privacy scope, and any caption they added

## Scope

- Only runs on the logged-in user's own profile page (`/your-slug` or `/profile.php?id=<your-id>`)
- Only shows the link on posts that have at least 1 share
- Some sharers may not be visible to you (e.g. shares with restricted audiences) — the modal will indicate this

## How it works

Facebook removed the **UI** for showing who shared a post, but the underlying GraphQL endpoints are still live. The extension:

1. Scrapes session tokens (`fb_dtsg`, `lsd`, etc.) from the page
2. For each post on the profile, extracts the `pfbid` permalink ID from the post's anchor
3. Calls `CometUFISharesCountTooltipContentQuery` to get the share count (and a short list of resharers for the hover tooltip)
4. On click, calls `CometResharesDialogQuery` to get the full sharers list and renders a modal

No data is sent anywhere except to Facebook itself.

## Known limitations / things that might break

- Facebook can change the GraphQL `doc_id` values or query schemas at any time, in which case the extension will silently stop working until updated
- Facebook can remove the queries entirely, in which case this extension is dead
- Style/DOM changes on Facebook may misplace the injected link
- Hitting the API rapidly (e.g. very fast scrolling through a profile with many shared posts) may get rate-limited

## Files

- `manifest.json` — Manifest V3 manifest, content script on facebook.com only
- `content.js` — All the logic: token scraping, API calls, DOM observer, link injection, tooltip, modal
- `styles.css` — Minimal CSS, with light/dark mode support
