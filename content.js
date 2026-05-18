// FB Share Revealer — content script
// Scope: runs only on the logged-in user's own profile page.
// For each post on that page with shares > 0, injects a "N shares" link.
// Hover → tooltip with first sharers. Click → modal with all visible sharers.

window.__fbsrReport = window.__fbsrReport || [];

// =============================================================
// PFBID NETWORK INTERCEPT (runs at document_start, before FB code)
// Patches XMLHttpRequest to read /api/graphql/ responses, extracts
// reshare pfbids and indexes them by post_id, attached media id, and
// attached_story.post_id. Later, getPostPfbid() falls back to this map
// for posts whose pfbid hasn't been hydrated into the DOM yet.
// =============================================================
(function installPfbidIntercept() {
  if (window.__fbsrPfbidMap) return; // already installed
  const pfbidMap = new Map();
  const shareCountMap = new Map(); // pfbid -> share count (number)
  window.__fbsrPfbidMap = pfbidMap;
  window.__fbsrShareCountMap = shareCountMap;

  // Walks a top-level post object to find its share_count.count buried under
  // comet_sections/feedback/.../comet_ufi_summary_and_actions_renderer/feedback.
  // Avoids descending into attached_story so we don't pick up the original
  // post's count when this is a reshare.
  function findShareCount(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.share_count && typeof o.share_count.count === 'number') return o.share_count.count;
    for (const k in o) {
      if (k === 'attached_story') continue;
      const v = o[k];
      if (v && typeof v === 'object') {
        const found = findShareCount(v);
        if (found !== null) return found;
      }
    }
    return null;
  }

  // Treats the indexed value as a "feedback target" rather than strictly a
  // pfbid. For regular posts this is the pfbid extracted from wwwURL or
  // permalink_url (newer responses sometimes omit wwwURL entirely). For
  // group posts (which don't have pfbids) it's the numeric post_id from
  // the permalink like /groups/<g>/posts/<numeric>/. Both forms are valid
  // feedbackTargetID values for the tooltip and dialog queries.
  function extractFeedbackTarget(obj) {
    // 1. Pfbid in wwwURL (older shape — profile timeline query)
    if (typeof obj.wwwURL === 'string' && obj.wwwURL.indexOf('pfbid') !== -1) {
      const m = obj.wwwURL.match(/pfbid[A-Za-z0-9]+/);
      if (m) return m[0];
    }
    // 2. Pfbid in permalink_url (newer shape — news feed pagination query)
    if (typeof obj.permalink_url === 'string' && obj.permalink_url.indexOf('pfbid') !== -1) {
      const m = obj.permalink_url.match(/pfbid[A-Za-z0-9]+/);
      if (m) return m[0];
    }
    // 3. Group post: numeric id in /groups/<g>/posts/<numeric>/
    if (typeof obj.permalink_url === 'string') {
      const gm = obj.permalink_url.match(/\/groups\/[^/]+\/posts\/(\d+)/);
      if (gm) return gm[1];
    }
    return null;
  }

  function indexResponseForPfbids(obj, insideAttachedStory) {
    if (!obj || typeof obj !== 'object') return;
    if (!insideAttachedStory && typeof obj.post_id === 'string') {
      const target = extractFeedbackTarget(obj);
      if (target) {
        pfbidMap.set(obj.post_id, target);
        if (Array.isArray(obj.attachments)) {
          for (const att of obj.attachments) {
            if (!att) continue;
            if (att.media && att.media.id) pfbidMap.set(att.media.id, target);
            if (att.target && att.target.id) pfbidMap.set(att.target.id, target);
          }
        }
        // Group post: build a composite "<groupId>:<actorId>" key. The DOM of
        // a group post doesn't expose the post_id directly — only the group
        // link and the poster's profile link. This composite is the only
        // reliable way to look up the target from such DOM. Last-write-wins
        // means we only cover the most recent post by an actor in a group,
        // which is acceptable for feed scans.
        if (typeof obj.permalink_url === 'string') {
          const gm = obj.permalink_url.match(/\/groups\/[^/]+\/posts\/\d+/);
          if (gm) {
            const groupIdMatch = obj.permalink_url.match(/\/groups\/([^/]+)\//);
            const groupId = groupIdMatch && groupIdMatch[1];
            const actor = Array.isArray(obj.actors) ? obj.actors[0] : null;
            const actorId = actor && actor.id;
            if (groupId && actorId) {
              pfbidMap.set(`group:${groupId}:${actorId}`, target);
            }
          }
        }
        if (obj.attached_story) {
          if (obj.attached_story.post_id && !pfbidMap.has(obj.attached_story.post_id)) {
            pfbidMap.set(obj.attached_story.post_id, target);
          }
        }
      }
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        indexResponseForPfbids(v, insideAttachedStory || k === 'attached_story');
      }
    }
  }

  // Second pass: walk top-level feed edges to associate share_count with
  // the post's feedback target. Done separately so we don't blow up the
  // recursive indexer with extra logic.
  function indexShareCountsFromEdges(obj) {
    if (!obj || typeof obj !== 'object') return;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      const story = node?.comet_sections?.content?.story;
      if (story && typeof story.post_id === 'string') {
        const target = extractFeedbackTarget(story) || extractFeedbackTarget(node);
        if (target) {
          const count = findShareCount(node.comet_sections);
          if (count !== null) shareCountMap.set(target, count);
        }
      }
      for (const k in node) {
        if (k === 'attached_story') continue;
        const v = node[k];
        if (v && typeof v === 'object') visit(v);
      }
    }
    visit(obj);
  }

  function processBody(text) {
    if (!text || text.indexOf('pfbid') === -1 && text.indexOf('/groups/') === -1) return;
    const beforeSize = pfbidMap.size;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        indexResponseForPfbids(parsed);
        indexShareCountsFromEdges(parsed);
      } catch (e) { /* ignore */ }
    }
    // Notify any listener that new entries have been indexed. The main script
    // uses this to re-scan posts that didn't have a pfbid on first pass.
    if (pfbidMap.size > beforeSize) {
      const cb = window.__fbsrOnMapUpdate;
      if (typeof cb === 'function') {
        try { cb(); } catch (e) { /* ignore */ }
      }
    }
  }

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__fbsrUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      if (xhr.__fbsrUrl && String(xhr.__fbsrUrl).indexOf('/api/graphql') !== -1) {
        xhr.addEventListener('load', function () {
          if (xhr.status === 200 && xhr.responseText) {
            try { processBody(xhr.responseText); } catch (e) { /* ignore */ }
          }
        });
      }
      return origSend.apply(this, arguments);
    };
    console.log('[FBSR] pfbid intercept installed (XHR)');
  } catch (e) {
    console.warn('[FBSR] pfbid intercept failed:', e);
  }
})();

function fbsrMain() {
  'use strict';

  // Set to false to enable the extension on every FB page (groups, news feed,
  // other users' profiles, etc.). When true, runs only on the logged-in
  // user's own profile, matching the original scope. The intercept above
  // runs regardless of this flag.
  const RESTRICT_TO_OWN_PROFILE = false;

  // ============================================================
  // Debug logging
  // ============================================================
  const DEBUG = true;
  const LOG_PREFIX = '[FBSR]';

  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    if (DEBUG) console.warn(LOG_PREFIX, ...args);
  }
  function err(...args) {
    if (DEBUG) console.error(LOG_PREFIX, ...args);
  }
  function group(label, fn) {
    if (!DEBUG) return fn();
    console.groupCollapsed(LOG_PREFIX + ' ' + label);
    try {
      return fn();
    } finally {
      console.groupEnd();
    }
  }

  log('script loaded at', new Date().toISOString(), '| url:', location.href);

  // ============================================================
  // Token scraping
  // ============================================================

  function scrapeTokens() {
    const html = document.documentElement.innerHTML;
    const fbDtsg =
      html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/)?.[1] ||
      html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ||
      html.match(/name="fb_dtsg" value="([^"]+)"/)?.[1];
    const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
    const userId = document.cookie.match(/c_user=(\d+)/)?.[1];

    log('scrapeTokens:', {
      fbDtsg: fbDtsg ? `${fbDtsg.slice(0, 6)}…(${fbDtsg.length} chars)` : null,
      lsd: lsd ? `${lsd.slice(0, 6)}…` : null,
      userId,
    });

    if (!fbDtsg || !userId) return null;
    const jazoest = '2' + [...fbDtsg].reduce((s, c) => s + c.charCodeAt(0), 0);
    return { fbDtsg, lsd: lsd || '', userId, jazoest };
  }

  let tokens = scrapeTokens();
  if (!tokens) {
    err('Failed to scrape tokens. Are you logged in?');
    return;
  }

  // ============================================================
  // Profile-page detection
  // ============================================================

  let cachedSlug = null;

  function getOwnSlug() {
    if (cachedSlug) {
      log('getOwnSlug: using cached slug:', cachedSlug);
      return cachedSlug;
    }

    return group('getOwnSlug — scanning for slug', () => {
      // Strategy 1: anchors that include profile.php?id=<userId>
      const numericAnchors = document.querySelectorAll(
        `a[href*="profile.php?id=${tokens.userId}"]`
      );
      log(`Strategy 1: found ${numericAnchors.length} numeric-id anchors`);

      // Strategy 2: if the URL slug matches the (sole or any) "vanity" field in HTML, it's ours
      const html = document.documentElement.innerHTML;
      const vanities = [...html.matchAll(/"vanity":"([^"]+)"/g)].map(m => m[1]);
      log(`Strategy 2: found ${vanities.length} vanity field(s) in HTML:`, vanities);
      const urlSlugMatch = location.pathname.match(/^\/([^\/\?#]+)(?:\/|$)/);
      const urlSlug = urlSlugMatch && urlSlugMatch[1] !== 'profile.php' ? urlSlugMatch[1] : null;
      if (urlSlug && vanities.includes(urlSlug)) {
        log('Strategy 2: URL slug matches a vanity in HTML →', urlSlug);
        cachedSlug = urlSlug;
        return cachedSlug;
      }

      // Strategy 3: scan labeled anchors for "Your profile" type aria
      const labeledAnchors = [...document.querySelectorAll('a[aria-label][href]')];
      log(`Strategy 3: scanning ${labeledAnchors.length} labeled anchors`);
      for (const a of labeledAnchors) {
        const aria = (a.getAttribute('aria-label') || '').toLowerCase();
        const href = a.getAttribute('href') || '';
        if (aria.includes('your profile')) {
          const m = href.match(/^\/([^\/\?#]+)(?:\/|\?|$)/);
          if (m && m[1] !== 'profile.php') {
            log('Strategy 3: matched aria "your profile" →', m[1]);
            cachedSlug = m[1];
            return cachedSlug;
          }
        }
      }

      // Strategy 4: "Edit profile" button visible → URL slug is ours
      const editProfileBtn = [
        ...document.querySelectorAll('div[role="button"], a[role="button"]'),
      ].find(
        (b) =>
          /edit profile/i.test(b.textContent || '') ||
          /edit profile/i.test(b.getAttribute('aria-label') || '')
      );
      if (editProfileBtn) {
        const m = location.pathname.match(/^\/([^\/\?#]+)(?:\/|$)/);
        if (m && m[1] !== 'profile.php') {
          log('Strategy 4: "Edit profile" button present → URL slug is ours:', m[1]);
          cachedSlug = m[1];
          return cachedSlug;
        }
      } else {
        log('Strategy 4: no "Edit profile" button visible');
      }

      warn('getOwnSlug: ALL strategies failed');
      return null;
    });
  }

  function isOnOwnProfile() {
    const path = location.pathname;
    const search = location.search;

    const idMatch = search.match(/[?&]id=(\d+)/);
    if (path === '/profile.php' && idMatch && idMatch[1] === tokens.userId) {
      log('isOnOwnProfile: TRUE (profile.php?id=', tokens.userId, ')');
      return true;
    }

    const slug = getOwnSlug();
    if (!slug) {
      log('isOnOwnProfile: FALSE (no slug determined)');
      return false;
    }
    const m = path.match(/^\/([^\/]+)(?:\/|$)/);
    if (!m) {
      log('isOnOwnProfile: FALSE (path does not look like profile path):', path);
      return false;
    }
    const result = m[1].toLowerCase() === slug.toLowerCase();
    log(`isOnOwnProfile: ${result ? 'TRUE' : 'FALSE'} (path slug "${m[1]}" vs own "${slug}")`);
    return result;
  }

  // ============================================================
  // GraphQL client
  // ============================================================

  async function callGraphQL({ friendlyName, docId, variables }) {
    if (!tokens) tokens = scrapeTokens();
    if (!tokens) throw new Error('No tokens');

    log(`GraphQL → ${friendlyName}`, { variables });

    const body = new URLSearchParams({
      av: tokens.userId,
      __user: tokens.userId,
      __a: '1',
      __req: '1',
      fb_dtsg: tokens.fbDtsg,
      jazoest: tokens.jazoest,
      lsd: tokens.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: friendlyName,
      server_timestamps: 'true',
      variables: JSON.stringify(variables),
      doc_id: docId,
    });

    const res = await fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-fb-friendly-name': friendlyName,
        'x-fb-lsd': tokens.lsd,
      },
      body: body.toString(),
    });
    const text = await res.text();
    const firstChunk = text.replace(/^for \(;;\);/, '').split('\n')[0];
    const parsed = JSON.parse(firstChunk);
    log(`GraphQL ← ${friendlyName}`, parsed.errors ? { errors: parsed.errors } : 'ok');
    return parsed;
  }

  function tooltipQuery(pfbid) {
    return callGraphQL({
      friendlyName: 'CometUFISharesCountTooltipContentQuery',
      docId: '9843821265734688',
      variables: { feedbackTargetID: pfbid },
    });
  }

  // Initial page: fetch first batch of sharers + the feedback base64 id we
  // need for subsequent paginated requests.
  function dialogQuery(pfbid, count = 10) {
    return callGraphQL({
      friendlyName: 'CometResharesDialogQuery',
      docId: '26194058653607577',
      variables: {
        count,
        feedbackID: pfbid,
        feedbackSource: 1,
        feedLocation: 'SHARE_OVERLAY',
        privacySelectorRenderLocation: 'COMET_STREAM',
        renderLocation: 'reshares_dialog',
        scale: 1,
        __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
        __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
        __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
        __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false,
        __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
        __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
        __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
        __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
        __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
        __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: false,
        __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
        __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
        __relay_internal__pv__IsMergQAPollsrelayprovider: false,
        __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
        __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
        __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'ORIGINAL',
        __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
        __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
        __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
        __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
      },
    });
  }

  // Subsequent pages: take the base64 feedback `id` from the first response
  // and a `cursor`. Returns more reshare edges under data.node.reshares.
  function paginationQuery(feedbackBase64Id, cursor, count = 10) {
    return callGraphQL({
      friendlyName: 'CometResharesFeedPaginationQuery',
      docId: '36071431812455144',
      variables: {
        count,
        cursor,
        feedLocation: 'SHARE_OVERLAY',
        feedbackSource: 1,
        focusCommentID: null,
        privacySelectorRenderLocation: 'COMET_STREAM',
        referringStoryRenderLocation: null,
        renderLocation: 'reshares_dialog',
        scale: 1,
        useDefaultActor: false,
        id: feedbackBase64Id,
        __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
        __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
        __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
        __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false,
        __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
        __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
        __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
        __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
        __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
        __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: false,
        __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
        __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
        __relay_internal__pv__IsMergQAPollsrelayprovider: false,
        __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
        __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
        __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'ORIGINAL',
        __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
        __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
        __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
        __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
      },
    });
  }

  // ============================================================
  // Post discovery
  // ============================================================

  function getPostPfbid(article) {
    const aria = article.getAttribute('aria-label') || '';
    if (/^(Comment|Reply) by/i.test(aria)) {
      log('skipping article (comment/reply):', aria.slice(0, 60));
      return null;
    }
    const html = article.outerHTML;
    // 1. DOM scrape: pfbid in the rendered timestamp link.
    const m = html.match(/pfbid[A-Za-z0-9]+/);
    if (m) {
      log('found pfbid via DOM:', m[0].slice(0, 20) + '…');
      return m[0];
    }
    // 2. Group post permalink with explicit post id: /groups/<g>/posts/<numeric>/
    const gm = html.match(/\/groups\/[^/]+\/posts\/(\d+)/);
    if (gm) {
      log(`found group post target via DOM: ${gm[1]}`);
      return gm[1];
    }
    const map = window.__fbsrPfbidMap;
    if (map && map.size) {
      // 3. Composite key lookup: some group posts only expose the group link
      //    and the poster's user link in the DOM (no post id at all). Build
      //    a "group:<groupId>:<actorId>" key from the DOM and try the map.
      const groupOnly = html.match(/\/groups\/(\d+)\/user\/(\d+)\//);
      if (groupOnly) {
        const compositeKey = `group:${groupOnly[1]}:${groupOnly[2]}`;
        const target = map.get(compositeKey);
        if (target) {
          log(`found target via composite group key: ${compositeKey} -> ${String(target).slice(0, 20)}…`);
          return target;
        }
      }
      // 4. Map lookup by any long numeric ID in the container.
      const ids = new Set(html.match(/\b\d{14,20}\b/g) || []);
      for (const id of ids) {
        const target = map.get(id);
        if (target) {
          log(`found target via map: id=${id} -> ${String(target).slice(0, 20)}…`);
          return target;
        }
      }
      log(`no target in DOM; tried ${ids.size} ids against map (size ${map.size}), no match`);
    } else {
      log('no target found in article, map empty');
    }
    return null;
  }

  // ============================================================
  // Link injection
  // ============================================================

  const processed = new WeakSet();
  let postCounter = 0;

  const retryScheduled = new WeakSet();

  function setupPfbidRetry(article, postIdx) {
    if (retryScheduled.has(article)) return;
    retryScheduled.add(article);

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        log(`retry #${postIdx}: post in viewport, waiting 1500ms for hydration`);
        io.disconnect();
        setTimeout(() => {
          log(`retry #${postIdx}: re-running processPost`);
          processPost(article);
        }, 1500);
        break;
      }
    }, { threshold: 0.3 });

    io.observe(article);
  }

  async function processPost(article) {
    if (processed.has(article)) return;
    processed.add(article);
    const postIdx = ++postCounter;
    const rect = article.getBoundingClientRect();
    const messageEl = article.querySelector('[data-ad-rendering-role="story_message"], [data-ad-preview="message"]');
    const messagePreview = messageEl ? messageEl.textContent.slice(0, 60).replace(/\s+/g, ' ') : '(no message el)';
    log(`processPost #${postIdx}: starting`);
    log(`  container tag=${article.tagName} class="${article.className.slice(0, 60)}..."`);
    log(`  rect: top=${Math.round(rect.top)} left=${Math.round(rect.left)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`);
    log(`  message preview: "${messagePreview}"`);

    let pfbid = getPostPfbid(article);
    if (!pfbid) {
      log(`processPost #${postIdx}: no pfbid on first pass, setting up viewport retry`);
      processed.delete(article);
      setupPfbidRetry(article, postIdx);
      return;
    }

    // Use the count from the intercepted feed response. If it's not present
    // (older response shape, or response not yet seen), fall back to a single
    // tooltip query. The tooltip's resharer list is fetched LAZILY on first
    // hover, not here — avoids per-post API calls on viewport entry and
    // keeps us well clear of FB's rate limit during long scrolls.
    let count = window.__fbsrShareCountMap && window.__fbsrShareCountMap.get(pfbid);
    if (typeof count !== 'number') {
      log(`processPost #${postIdx}: count not cached, falling back to tooltipQuery`);
      try {
        const data = await tooltipQuery(pfbid);
        count = data?.data?.feedback?.reshares?.count;
      } catch (e) {
        err(`processPost #${postIdx}: tooltip query threw`, e);
        return;
      }
    }
    log(`processPost #${postIdx}: pfbid=${pfbid.slice(0, 24)}… count=${count}`);
    window.__fbsrReport.push({ postIdx, pfbid, count, message: messagePreview });
    if (!count || count <= 0) {
      log(`processPost #${postIdx}: count is zero, skipping injection`);
      return;
    }

    // Pass empty resharers — the tooltip will fetch them on first hover.
    injectLink(article, pfbid, count, [], postIdx);
  }

  function injectLink(article, pfbid, count, initialResharers, postIdx) {
    if (article.querySelector('.fbsr-link-container')) {
      log(`injectLink #${postIdx}: container already exists, skipping`);
      return;
    }

    log(`injectLink #${postIdx}: injecting "${count} share${count !== 1 ? 's' : ''}" link`);

    const container = document.createElement('div');
    container.className = 'fbsr-link-container';

    const link = document.createElement('a');
    link.className = 'fbsr-link';
    link.href = '#';
    link.textContent = count === 1 ? '1 share' : `${count} shares`;
    let tooltipEl = null;
    let hoverTimer = null;
    // Lazy: tooltipData is null until first hover triggers a fetch. If we
    // were handed initialResharers from a prior tooltipQuery call (legacy
    // path), use those.
    let tooltipData = initialResharers && initialResharers.length ? initialResharers : null;
    let tooltipFetchInFlight = false;

    async function ensureTooltipData() {
      if (tooltipData || tooltipFetchInFlight) return;
      tooltipFetchInFlight = true;
      try {
        const data = await tooltipQuery(pfbid);
        tooltipData = data?.data?.feedback?.legacy_resharers || [];
        // Re-render if the tooltip is still visible.
        if (tooltipEl) renderTooltipContent(tooltipEl, tooltipData, count);
      } catch (e) {
        err(`tooltip #${postIdx}: fetch failed`, e);
        tooltipData = [];
        if (tooltipEl) renderTooltipContent(tooltipEl, tooltipData, count);
      } finally {
        tooltipFetchInFlight = false;
      }
    }

    function showTooltip() {
      if (tooltipEl) return;
      log(`tooltip #${postIdx}: showing`);
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'fbsr-tooltip';
      // If we don't have the data yet, render a loading state and trigger
      // the fetch. ensureTooltipData() re-renders when data arrives.
      if (tooltipData) {
        renderTooltipContent(tooltipEl, tooltipData, count);
      } else {
        const loading = document.createElement('span');
        loading.className = 'fbsr-tooltip-loading';
        loading.textContent = 'Loading…';
        tooltipEl.appendChild(loading);
        ensureTooltipData();
      }
      document.body.appendChild(tooltipEl);
      positionTooltip(tooltipEl, link);
    }

    function hideTooltip() {
      if (tooltipEl) {
        log(`tooltip #${postIdx}: hiding`);
        tooltipEl.remove();
        tooltipEl = null;
      }
    }

    link.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(showTooltip, 300);
    });
    link.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      hideTooltip();
    });

    link.addEventListener('click', (e) => {
      e.preventDefault();
      log(`link #${postIdx}: clicked, opening modal`);
      hideTooltip();
      openModal(pfbid, count);
    });

    container.appendChild(link);
    placeContainer(article, container, postIdx);
  }

  function renderTooltipContent(el, resharers, count) {
    el.innerHTML = '';
    if (!resharers || resharers.length === 0) {
      const s = document.createElement('span');
      s.className = 'fbsr-tooltip-loading';
      s.textContent = count > 0 ? 'No visible sharers' : 'No shares';
      el.appendChild(s);
      return;
    }
    for (const r of resharers) {
      const n = document.createElement('span');
      n.className = 'fbsr-tooltip-name';
      n.textContent = r.name;
      el.appendChild(n);
    }
    if (resharers.length < count) {
      const more = document.createElement('span');
      more.className = 'fbsr-tooltip-name';
      more.style.color = '#65676b';
      more.textContent = `and ${count - resharers.length} more`;
      el.appendChild(more);
    }
  }

  function positionTooltip(tooltipEl, anchor) {
    const r = anchor.getBoundingClientRect();
    const t = tooltipEl.getBoundingClientRect();
    let top = window.scrollY + r.bottom + 6;
    let left = window.scrollX + r.left;
    if (left + t.width > window.scrollX + window.innerWidth - 8) {
      left = window.scrollX + window.innerWidth - t.width - 8;
    }
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
  }

  // ============================================================
  // Container placement
  // ============================================================

  function placeContainer(article, container, postIdx) {
    const shareBtn = article.querySelector('[data-ad-rendering-role="share_button"]');
    if (!shareBtn) {
      warn(`placeContainer #${postIdx}: no share button`);
      article.appendChild(container);
      return;
    }

    // Walk up to find the action row (smallest ancestor with all 3 action buttons, no composer).
    let actionRow = shareBtn;
    for (let i = 0; i < 10 && actionRow; i++) {
      actionRow = actionRow.parentElement;
      if (!actionRow || actionRow === article) break;
      const hasLike = !!actionRow.querySelector('[aria-label="Like"]');
      const hasComment = !!actionRow.querySelector('[aria-label="Leave a comment"]');
      const hasShare = !!actionRow.querySelector('[data-ad-rendering-role="share_button"]');
      const hasEditable = !!actionRow.querySelector('[contenteditable="true"]');
      if (hasLike && hasComment && hasShare && !hasEditable) {
        // Insert as the LAST child of the action row, so the flex layout
        // places our link inline with the like/comment/share buttons.
        actionRow.appendChild(container);
        const rect = container.getBoundingClientRect();
        log(`placeContainer #${postIdx}: appended into action row at depth ${i + 1}, rect: top=${Math.round(rect.top)} left=${Math.round(rect.left)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`);
        return;
      }
    }
    warn(`placeContainer #${postIdx}: walk failed, appending to article`);
    article.appendChild(container);
  }

  // ============================================================
  // Modal
  // ============================================================

  function openModal(pfbid, count) {
    const backdrop = document.createElement('div');
    backdrop.className = 'fbsr-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'fbsr-modal';

    const header = document.createElement('div');
    header.className = 'fbsr-modal-header';
    const title = document.createElement('span');
    title.className = 'fbsr-modal-title';
    title.textContent = 'People who shared this';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'fbsr-modal-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'fbsr-modal-body';
    const status = document.createElement('div');
    status.className = 'fbsr-modal-status';
    status.textContent = 'Loading…';
    body.appendChild(status);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Prevent the page behind the modal from scrolling. FB applies
    // overflow-y: scroll on <html> with !important, so we can't beat it by
    // setting overflow there. Instead, freeze the body in place via
    // position: fixed and re-apply the current scroll offset as a negative
    // top, then restore on close.
    const scrollY = window.scrollY;
    const prevBodyStyle = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';

    function close() {
      log('modal: closing');
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      // Restore body styles and scroll position.
      document.body.style.position = prevBodyStyle.position;
      document.body.style.top = prevBodyStyle.top;
      document.body.style.left = prevBodyStyle.left;
      document.body.style.right = prevBodyStyle.right;
      document.body.style.width = prevBodyStyle.width;
      window.scrollTo(0, scrollY);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);

    // Paginated fetch: load first page, then auto-fetch more when the user
    // scrolls to the bottom of the modal body. Stop when has_next_page is false.
    const renderedIds = new Set(); // dedupe by edge.node.id
    let nextCursor = null;
    let hasMore = true;
    let loading = false;
    let totalRendered = 0;

    function renderEdges(edges) {
      for (const edge of edges) {
        const id = edge?.node?.id;
        if (id && renderedIds.has(id)) continue;
        if (id) renderedIds.add(id);
        const row = buildSharerRow(edge);
        if (row) {
          body.appendChild(row);
          totalRendered++;
        }
      }
    }

    function showStatus(text) {
      const s = document.createElement('div');
      s.className = 'fbsr-modal-status';
      s.textContent = text;
      body.appendChild(s);
      return s;
    }

    let sentinel = null;
    let io = null;

    // After the first page we'll need the feedback's base64 id (different
    // from the pfbid) to drive the pagination query.
    let feedbackBase64Id = null;
    let firstPageLoaded = false;

    async function loadMore() {
      if (loading || !hasMore) return;
      loading = true;
      const loadingEl = sentinel ? null : showStatus('Loading sharers…');
      try {
        const prevCursor = nextCursor;
        let reshares;
        if (!firstPageLoaded) {
          const data = await dialogQuery(pfbid, 10);
          feedbackBase64Id = data?.data?.feedback?.id || null;
          reshares = data?.data?.feedback?.reshares;
          firstPageLoaded = true;
        } else {
          if (!feedbackBase64Id || !nextCursor) {
            hasMore = false;
          } else {
            const data = await paginationQuery(feedbackBase64Id, nextCursor, 10);
            // Pagination response wraps the connection under `node`.
            reshares = data?.data?.node?.reshares || data?.data?.feedback?.reshares;
          }
        }

        const edges = reshares?.edges || [];
        const pageInfo = reshares?.page_info || reshares?.pageInfo || {};
        nextCursor = pageInfo.end_cursor || pageInfo.endCursor || null;
        const cursorAdvanced = nextCursor && nextCursor !== prevCursor;
        const reportedHasNext = pageInfo.has_next_page !== undefined ? pageInfo.has_next_page : pageInfo.hasNextPage;
        hasMore = edges.length > 0 && cursorAdvanced && reportedHasNext !== false;
        log(`modal: page returned ${edges.length} edges, hasMore=${hasMore}, feedbackId=${feedbackBase64Id ? feedbackBase64Id.slice(0, 12) + '…' : 'none'}, cursor=${nextCursor ? String(nextCursor).slice(0, 12) + '…' : 'none'}`);

        if (loadingEl) loadingEl.remove();
        if (sentinel) { sentinel.remove(); sentinel = null; }

        renderEdges(edges);

        if (totalRendered === 0 && !hasMore) {
          showStatus(count > 0 ? 'No visible sharers (some may be private).' : 'No one has shared this post.');
          return;
        }
        if (totalRendered < count && !hasMore) {
          const hidden = count - totalRendered;
          showStatus(`${hidden} sharer${hidden === 1 ? '' : 's'} hidden by privacy settings.`);
          return;
        }
        if (hasMore) {
          sentinel = document.createElement('div');
          sentinel.className = 'fbsr-modal-status';
          sentinel.textContent = 'Loading more…';
          body.appendChild(sentinel);
          if (!io) {
            io = new IntersectionObserver((entries) => {
              for (const e of entries) {
                if (e.isIntersecting) loadMore();
              }
            }, { root: body, threshold: 0.1 });
          }
          io.observe(sentinel);
        }
      } catch (e) {
        err('modal: page query failed', e);
        if (loadingEl) loadingEl.remove();
        if (sentinel) { sentinel.remove(); sentinel = null; }
        showStatus('Failed to load sharers.');
      } finally {
        loading = false;
      }
    }

    // Cleanup observer when modal closes. We rely on the original `close`
    // function (declared above) — we just intercept it to also disconnect
    // the IntersectionObserver. Wrap by overriding the global function via
    // a flag check instead of reassignment (function declarations can't be
    // reassigned in strict mode reliably across scopes).
    const origRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = function () {
      if (io) { io.disconnect(); io = null; }
      origRemove();
    };

    // Clear the initial "Loading…" status that the outer code put in body.
    body.innerHTML = '';

    loadMore();
  }

  function buildSharerRow(edge) {
    const node = edge.node;
    const shareStory = node?.comet_sections?.context_layout?.story;
    if (!shareStory) {
      warn('buildSharerRow: missing context_layout.story');
      return null;
    }
    const actor = shareStory.comet_sections?.actor_photo?.story?.actors?.[0];
    if (!actor) {
      warn('buildSharerRow: missing actor');
      return null;
    }

    let creationTime = null;
    let privacyDesc = null;
    let privacyIconName = null;
    for (const m of shareStory.comet_sections?.metadata || []) {
      const tn = m.__typename;
      if (tn === 'CometFeedStoryLongerTimestampStrategy' && m.story?.creation_time) {
        creationTime = m.story.creation_time;
      } else if (tn === 'CometFeedStoryAudienceStrategy') {
        privacyDesc = m.story?.privacy_scope?.description;
        privacyIconName = m.story?.privacy_scope?.icon_image?.name;
      }
    }

    const captionText =
      node?.comet_sections?.content?.story?.comet_sections?.message?.story?.message?.text;
    const hasAttachment = (node?.attachments?.length || 0) > 0
      || (node?.comet_sections?.content?.story?.attachments?.length || 0) > 0
      || !!node?.attached_story;
    const profileHref = actor.profile_url || actor.url || '#';
    const postHref = node.permalink_url || '#';

    const card = document.createElement('div');
    card.className = 'fbsr-sharer-card';

    const header = document.createElement('div');
    header.className = 'fbsr-sharer-header';

    // Avatar → profile
    const avatarLink = document.createElement('a');
    avatarLink.href = profileHref;
    avatarLink.target = '_blank';
    avatarLink.rel = 'noopener noreferrer';
    avatarLink.className = 'fbsr-sharer-avatar-link';
    const img = document.createElement('img');
    img.className = 'fbsr-sharer-avatar';
    img.src = actor.profile_picture?.uri || '';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    avatarLink.appendChild(img);

    const info = document.createElement('div');
    info.className = 'fbsr-sharer-info';

    // Name → profile
    const nameLink = document.createElement('a');
    nameLink.className = 'fbsr-sharer-name';
    nameLink.href = profileHref;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.textContent = actor.name;
    info.appendChild(nameLink);

    // Friend descriptor like "shared a memory." if present in the title.
    const titleStory = shareStory.comet_sections?.title?.story;
    const titleText = titleStory?.title?.text;
    if (titleText && titleText.indexOf(actor.name) === 0) {
      const trailing = titleText.slice(actor.name.length).trim();
      if (trailing) {
        const sub = document.createElement('span');
        sub.className = 'fbsr-sharer-title-trail';
        sub.textContent = ' ' + trailing;
        nameLink.appendChild(sub);
      }
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'fbsr-sharer-meta';
    if (creationTime) {
      // Timestamp → the reshare post itself
      const ts = document.createElement('a');
      ts.className = 'fbsr-sharer-timestamp';
      ts.href = postHref;
      ts.target = '_blank';
      ts.rel = 'noopener noreferrer';
      ts.textContent = formatRelativeTime(creationTime);
      metaRow.appendChild(ts);
    }
    if (privacyIconName || privacyDesc) {
      if (creationTime) {
        const dot = document.createElement('span');
        dot.className = 'fbsr-sharer-dot';
        dot.textContent = ' · ';
        metaRow.appendChild(dot);
      }
      const pIcon = document.createElement('span');
      pIcon.className = 'fbsr-sharer-privacy';
      pIcon.title = privacyDesc || '';
      pIcon.textContent = privacyIconToGlyph(privacyIconName);
      metaRow.appendChild(pIcon);
    }
    if (metaRow.childNodes.length) info.appendChild(metaRow);

    // Caption is plain text, no link.
    if (captionText) {
      const caption = document.createElement('div');
      caption.className = 'fbsr-sharer-caption';
      caption.textContent = captionText;
      info.appendChild(caption);
    }

    header.appendChild(avatarLink);
    header.appendChild(info);
    card.appendChild(header);

    // Show Attachment → the ORIGINAL post (attached_story's permalink), not
    // the reshare. The reshare is already accessible via the timestamp link.
    const attachedStory = node?.attached_story
      || node?.comet_sections?.content?.story?.attached_story;
    const originalHref = attachedStory?.permalink_url || attachedStory?.url || null;
    if (hasAttachment && originalHref) {
      const showBtn = document.createElement('a');
      showBtn.className = 'fbsr-sharer-attachment-btn';
      showBtn.href = originalHref;
      showBtn.target = '_blank';
      showBtn.rel = 'noopener noreferrer';
      showBtn.textContent = 'Show Attachment';
      card.appendChild(showBtn);
    }

    return card;
  }

  function privacyIconToGlyph(name) {
    // FB's privacy icon names. Use unicode glyphs so we don't depend on icons.
    switch (name) {
      case 'globe':
      case 'everyone':
      case 'public': return '🌐';
      case 'friends': return '👥';
      case 'only_me':
      case 'lock': return '🔒';
      case 'custom': return '⚙';
      default: return '·';
    }
  }

  function formatRelativeTime(unix) {
    const diff = Date.now() / 1000 - unix;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
    return new Date(unix * 1000).toLocaleDateString();
  }

  // ============================================================
  // Observer
  // ============================================================

  function findPostContainers(root = document) {
    // A post is identifiable by having a share_button + comment_button.
    // The post container is the nearest ancestor that contains the message and the action row.
    const shareButtons = root.querySelectorAll('[data-ad-rendering-role="share_button"]');
    const containers = new Set();
    shareButtons.forEach(sb => {
      // Walk up until we find an element that ALSO contains a story_message
      let el = sb;
      for (let i = 0; i < 15 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.querySelector('[data-ad-rendering-role="story_message"]') ||
          el.querySelector('[data-ad-preview="message"]') ||
          el.querySelector('[aria-label^="Actions for this post"]')) {
          containers.add(el);
          break;
        }
      }
    });
    return [...containers];
  }

  function scanExistingPosts() {
    if (RESTRICT_TO_OWN_PROFILE && !isOnOwnProfile()) {
      log('scanExistingPosts: not on own profile, skipping scan');
      return;
    }
    const posts = findPostContainers();
    log(`scanExistingPosts: found ${posts.length} post container(s)`);
    posts.forEach(processPost);
  }

  let mutationCount = 0;
  const observer = new MutationObserver((mutations) => {
    mutationCount++;
    if (RESTRICT_TO_OWN_PROFILE && !isOnOwnProfile()) return;
    const containers = new Set();
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        findPostContainers(node).forEach(c => containers.add(c));
        // Also check if the added node itself completes a post
        if (node.querySelector?.('[data-ad-rendering-role="share_button"]')) {
          findPostContainers(node.parentElement || node).forEach(c => containers.add(c));
        }
      }
    }
    // Catch hydration of existing skeletons by rescanning periodically when mutations occur
    if (mutations.length > 0) {
      findPostContainers().forEach(c => {
        if (!processed.has(c)) containers.add(c);
      });
    }
    if (containers.size > 0) {
      log(`observer: batch #${mutationCount}, ${containers.size} post container(s)`);
      containers.forEach(processPost);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  log('observer: attached to document.body');

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      log('URL changed:', lastUrl, '→', location.href);
      lastUrl = location.href;
      cachedSlug = null;
      setTimeout(scanExistingPosts, 500);
    }
  }, 1000);

  setTimeout(() => {
    log('initial scan starting (after 1500ms delay)');
    scanExistingPosts();
  }, 1500);

  // When the intercept indexes new entries, re-scan posts that didn't have
  // a pfbid on first pass. processed is a WeakSet keyed by article, and
  // processPost early-exits if already present, so this is safe — only
  // newly-unprocessed articles (those we explicitly removed via
  // processed.delete) will be re-tried.
  let mapRescanTimer = null;
  window.__fbsrOnMapUpdate = () => {
    if (mapRescanTimer) return;
    // Debounce: many responses can arrive in a short burst.
    mapRescanTimer = setTimeout(() => {
      mapRescanTimer = null;
      log('mapUpdate: re-scanning posts');
      scanExistingPosts();
    }, 250);
  };
}

// Run main logic once DOM is ready (the intercept above runs immediately so it
// can patch XHR before FB issues any /api/graphql/ requests).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fbsrMain, { once: true });
} else {
  fbsrMain();
}