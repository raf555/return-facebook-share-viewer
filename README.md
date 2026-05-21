# Return Facebook Share Viewer

Restores the "who shared this post" feature on Facebook, which was silently removed in late 2025.

Works everywhere on Facebook — your own profile, friends' profiles, groups, news feed, and standalone photo/video pages.

## Install

1. Open `chrome://extensions/`
2. Toggle on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

## Usage

Scroll through your Facebook feed. For each post with at least one share, a `N shares` link appears in the action row next to Like / Comment / Share.

- **Hover** the link → tooltip with the first few sharers' names
- **Click** the link → modal listing all visible sharers, with avatars, timestamps, privacy scope, and any caption they added

## How it works

Facebook removed the UI for sharing data, but the underlying GraphQL endpoints are still live. The extension:

1. Patches `XMLHttpRequest` at page load (before Facebook's own scripts run) to intercept every `/api/graphql/` response and index post identifiers into a local map
2. Parses Facebook's server-rendered inline `<script>` JSON blobs to seed the map with posts visible on initial page load
3. Scrapes session tokens (`fb_dtsg`, `lsd`, `c_user`) from the page for API calls
4. For each post in the feed, extracts the feedback target (pfbid or numeric post id) from the DOM or the intercepted map
5. Calls `CometUFISharesCountTooltipContentQuery` to get the share count — posts with 0 shares are skipped entirely
6. On hover, fetches a short resharers list for the tooltip
7. On click, calls `CometResharesDialogQuery` + `CometResharesFeedPaginationQuery` for the full paginated list

No data is sent anywhere except to Facebook itself.

## Files

- `manifest.json` — Manifest V3, content script injected into facebook.com at `document_start` in the MAIN world
- `content.js` — All logic: XHR intercept, token scraping, API calls, DOM observer, link injection, tooltip, modal
- `styles.css` — Minimal CSS with light/dark mode support via CSS variables

## Known limitations

**Some posts require a hover before the share link appears.**
Facebook lazy-hydrates post identifiers (pfbids) into the DOM only when the user hovers the post's timestamp link. Until then, the DOM has no identifier to work with. Once hydrated, the link appears automatically. There is no way to force this without triggering Facebook's own hovercard popup, which is visually unacceptable.

**Reshares may show the original post's count instead of the reshare's count.**
When a friend reshares someone else's post, Facebook sometimes only renders the original post's pfbid in the DOM — not the reshare's own pfbid. In this case the extension may display the original's share count on the reshare card. The correct count appears after the user hovers the reshare's own timestamp.

**Reel standalone pages (`/reel/<id>/`) are not yet supported.**
The layout differs from `/watch` and `/photo` pages. Planned for a future update.

**Some posts never show a share link, even after hovering.**
A small number of post types have no identifying information in the DOM at all — no pfbid, no group post URL, no numeric ID that maps to anything in the intercepted data. This can happen with certain reshare formats, tagged posts, or posts that were server-rendered in a shape the extension does not recognize. These posts are silently skipped. There is currently no known fix.

**Rate limiting.**
Scrolling very fast through a long feed makes many API calls in quick succession. Facebook may rate-limit responses, causing some posts to silently miss their share count.

**API breakage.**
Facebook can change GraphQL `doc_id` values or query schemas at any time. If that happens the extension stops working silently until updated.

## Debug mode

`window.__FBSR_DEBUG = true` (default) enables:
- Console logging prefixed with `[FBSR]`
- Capture of up to 50 recent GraphQL response bodies into `window.__feedBodies` for diagnostics

Set `window.__FBSR_DEBUG = false` to silence the extension.

Set `window.__FBSR_DISABLE_SEEDING = true` to skip inline-script seeding (useful for isolating bugs).
