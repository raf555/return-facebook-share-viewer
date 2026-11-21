# Return Facebook Share Viewer

Brings back the list of people who shared a Facebook post, which Facebook removed without notice in late 2025.

It works on your news feed, profiles, pages, groups and photo pages, including posts you open in a popup or a new tab.

## Install

1. Download `return-facebook-share-viewer-vX.Y.Z.zip` from the [latest release](https://github.com/raf555/return-facebook-share-viewer/releases/latest) and extract it.
2. Open `chrome://extensions/`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the extracted folder.

To update, extract the new zip over the old folder and click the reload icon on the extension's card. Unpacked extensions don't update themselves, but the extension checks GitHub once a day and shows UPD on its toolbar icon when a release is out.

To run from source instead, clone the repo and select its folder in step 4.

## Usage

Scroll through your Facebook feed. Each post with at least one share gets an `N shares` link in its action row, next to Like, Comment and Share.

- **Hover** the link to see the first few sharers' names.
- **Click** it for the full list of visible sharers, with avatars, captions and privacy. Each sharer's timestamp links to their post.

## Settings

Click the extension's toolbar icon to open its settings:

- **Show share links on Facebook**: turn the extension off without removing it.
- **Preview sharers on hover**: turn off the hover list to save one API call per hovered link. Clicking the link still opens the full list.
- **Check now** and **Check GitHub once a day**: look for a newer release. A newer version shows a link to its release page.
- **Debugging** (folded by default):
  - **Copy debug info** copies the extension and browser versions, your settings and the last 20 warnings and errors. Paste it into a GitHub issue when you report a bug. It holds no tokens, user ids or post content.
  - **Debug logging** and **Skip inline-script seeding**: see [Debug mode](#debug-mode).

Facebook tabs read the settings when they load. After you change one, click **Reload Facebook tabs** in the popup, or reload them yourself.

## How it works

Facebook removed the UI for sharing data, but the underlying GraphQL endpoints are still live. The extension:

1. Patches `XMLHttpRequest` and `fetch` at page load, before Facebook's own scripts run, to read every `/api/graphql/` response and index post identifiers and share counts into local maps.
2. Parses Facebook's server-rendered inline `<script>` JSON to seed those maps with the posts in the initial page.
3. Reads session tokens (`fb_dtsg`, `lsd`, `c_user`) from the page for its own API calls.
4. Finds each post's feedback target (a pfbid or numeric post id) from the DOM, the page URL or the intercepted maps. Facebook fills in a post's permalink only when you hover its timestamp. For posts with no id, the extension focuses the timestamp link once instead, which fills in the permalink without Facebook's date tooltip.
5. Gets the share count from the intercepted data, or from `CometUFISharesCountTooltipContentQuery` when it isn't cached. Posts with 0 shares get no link.
6. On hover, fetches a short sharer list for the tooltip.
7. On click, calls `CometResharesDialogQuery` and `CometResharesFeedPaginationQuery` for the full paginated list.

The extension sends data only to Facebook.

## Files

- `manifest.json`: Manifest V3. Injects the content script into facebook.com at `document_start` in the MAIN world.
- `content.js`: all logic (network intercept, token scraping, API calls, DOM observer, link injection, tooltip, modal).
- `bridge.js`: runs in the ISOLATED world, reads the settings from `chrome.storage` and passes them to `content.js`, which can't reach `chrome.storage` from the MAIN world.
- `background.js`: service worker for the daily update check and the toolbar badge.
- `popup/`: the settings popup.
- `styles.css`: minimal CSS with light and dark mode support.

## Known limitations

**Sponsored posts never get a share link.**
An ad's "Sponsored" label isn't a real permalink, so there's no post id to look up.

**A few posts still get no link.**
Some post types expose no id the extension recognizes, even after it focuses their timestamp, and the extension skips them. It also skips the focus step while you type in a comment box or any other field, so it won't take your cursor. Those posts get their link when they scroll back into view with nothing focused.

**Reels are not supported.**
That includes most videos: Facebook now redirects `/watch/?v=` and `/videos/<id>` links to `/reel/<id>`. A reel's page has a different layout, and the extension doesn't add a link there yet.

**Reshares may show the original post's count.**
When someone reshares a post, Facebook sometimes renders only the original post's pfbid. The extension accepts a pfbid only when it belongs to the post's own author. We haven't tested this on live reshares yet.

**Rate limiting.**
Fast scrolling through a long feed fires many API calls in a few seconds. Facebook may rate-limit them, and some posts then miss their share count.

**API breakage.**
Facebook can change GraphQL `doc_id` values or query schemas at any time. If that happens, the extension stops working until it's updated.

## Debug mode

Turn on **Debug logging** in the popup and reload Facebook. That enables:

- Console logging prefixed with `[FBSR]`.
- A capture of up to 50 recent GraphQL response bodies in `window.__feedBodies`.

To turn it on for one tab without a reload, run `window.__FBSR_DEBUG = true` in that tab's console. Logging and capture start from that point; earlier responses aren't captured. Set it to `false` to stop. You can also set `window.__FBSR_DEBUG = true` near the top of `content.js` and reload the extension. Keep that line `false` in releases. The release workflow stops with an error if it's `true`.

Turn on **Skip inline-script seeding** to stop the extension from reading Facebook's server-rendered posts when you isolate a bug.
