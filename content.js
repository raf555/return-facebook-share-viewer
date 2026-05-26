// FB Share Revealer — content script
// MV3, world: MAIN, run_at: document_start
// Injects a "N shares" link on every FB post with shares.
// Hover → tooltip preview. Click → paginated modal of sharers.

// ─── Debug flag ───────────────────────────────────────────────────────────────
// true  → logs to console + captures graphql responses into window.__feedBodies
// false → silent
window.__FBSR_DEBUG = false;

// ─── Network intercept ────────────────────────────────────────────────────────
// Runs at document_start before FB's own scripts. Patches XHR to read every
// /api/graphql/ response and build two maps:
//   __fbsrPfbidMap     : various IDs → feedback target (pfbid or numeric post id)
//   __fbsrShareCountMap: feedback target → cached share count
(function installIntercept() {
  if (window.__fbsrPfbidMap) return;

  const pfbidMap = new Map();
  const shareCountMap = new Map();
  window.__fbsrPfbidMap = pfbidMap;
  window.__fbsrShareCountMap = shareCountMap;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Given a post-shaped object, return its feedback target or null.
  // Accepts pfbid (from wwwURL or permalink_url) or a numeric group post id.
  function extractTarget(obj) {
    const www = obj.wwwURL;
    if (typeof www === 'string') {
      const m = www.match(/pfbid[A-Za-z0-9]+/);
      if (m) return m[0];
    }
    const pl = obj.permalink_url;
    if (typeof pl === 'string') {
      const m = pl.match(/pfbid[A-Za-z0-9]+/);
      if (m) return m[0];
      const g = pl.match(/\/groups\/[^/]+\/posts\/(\d+)/);
      if (g) return g[1];
    }
    return null;
  }

  // Walk the share_count field, skipping attached_story to avoid picking up
  // the original post's count when this object is a reshare.
  function findShareCount(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.share_count && typeof o.share_count.count === 'number') return o.share_count.count;
    for (const k in o) {
      if (k === 'attached_story') continue;
      const r = findShareCount(o[k]);
      if (r !== null) return r;
    }
    return null;
  }

  // Recursively index post objects. insideAttachedStory prevents us from
  // treating the embedded original's IDs as keys for the outer reshare.
  function indexResponse(obj, insideAttachedStory) {
    if (!obj || typeof obj !== 'object') return;

    if (!insideAttachedStory && typeof obj.post_id === 'string') {
      const target = extractTarget(obj);
      if (target) {
        pfbidMap.set(obj.post_id, target);

        // Attachment IDs: lets us resolve posts whose DOM only exposes a media id
        for (const att of (obj.attachments || [])) {
          if (!att) continue;
          if (att.media && att.media.id) pfbidMap.set(att.media.id, target);
          if (att.target && att.target.id) pfbidMap.set(att.target.id, target);
        }

        // Group composite key "group:<groupId>:<actorId>":
        // needed when the DOM only exposes /groups/<id>/user/<uid>/ links.
        const pl = obj.permalink_url;
        if (typeof pl === 'string' && /\/groups\/[^/]+\/posts\/\d+/.test(pl)) {
          const actorId = obj.actors && obj.actors[0] && obj.actors[0].id;
          if (actorId) {
            const slugId = (pl.match(/\/groups\/([^/]+)\//) || [])[1];
            const numericId = obj.feedback &&
              obj.feedback.associated_group &&
              obj.feedback.associated_group.id;
            if (slugId) pfbidMap.set(`group:${slugId}:${actorId}`, target);
            if (numericId && numericId !== slugId) pfbidMap.set(`group:${numericId}:${actorId}`, target);
          }
        }

        // No-overwrite: index attached_story's own post_id pointing back to the
        // reshare's target only if that slot is unclaimed (first-seen wins).
        if (obj.attached_story && obj.attached_story.post_id &&
          !pfbidMap.has(obj.attached_story.post_id)) {
          pfbidMap.set(obj.attached_story.post_id, target);
        }
      }
    }

    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        indexResponse(v, insideAttachedStory || k === 'attached_story');
      }
    }
  }

  // Walk feed edges to index share counts via comet_sections.
  function indexShareCounts(obj) {
    if (!obj || typeof obj !== 'object') return;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      const story = node.comet_sections && node.comet_sections.content && node.comet_sections.content.story;
      if (story && typeof story.post_id === 'string') {
        const target = extractTarget(story) || extractTarget(node);
        if (target) {
          const count = findShareCount(node.comet_sections);
          if (count !== null) shareCountMap.set(target, count);
        }
      }
      for (const k in node) {
        if (k === 'attached_story') continue;
        if (node[k] && typeof node[k] === 'object') visit(node[k]);
      }
    }
    visit(obj);
  }

  function onGraphQLResponse(text) {
    if (!text || (text.indexOf('pfbid') === -1 && text.indexOf('/groups/') === -1)) return;
    const before = pfbidMap.size;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        indexResponse(obj, false);
        indexShareCounts(obj);
      } catch (e) { /* ignore */ }
    }
    if (pfbidMap.size > before) {
      const cb = window.__fbsrOnMapUpdate;
      if (typeof cb === 'function') try { cb(); } catch (e) { /* ignore */ }
    }
  }

  // Exposed for inline-script seeding from fbsrMain
  window.__fbsrIndexObject = function (obj) {
    const before = pfbidMap.size;
    try { indexResponse(obj, false); indexShareCounts(obj); } catch (e) { /* ignore */ }
    const added = pfbidMap.size - before;
    if (added > 0) {
      const cb = window.__fbsrOnMapUpdate;
      if (typeof cb === 'function') try { cb(); } catch (e) { /* ignore */ }
    }
    return added;
  };

  // ── XHR patch ───────────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fbsrUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (window.__FBSR_DEBUG) this.__fbsrSentBody = body;
    if (this.__fbsrUrl && String(this.__fbsrUrl).indexOf('/api/graphql') !== -1) {
      this.addEventListener('load', () => {
        if (this.status !== 200 || !this.responseText) return;
        try { onGraphQLResponse(this.responseText); } catch (e) { /* ignore */ }
        if (window.__FBSR_DEBUG) {
          try {
            if (!window.__feedBodies) window.__feedBodies = [];
            let name = '?';
            try { name = new URLSearchParams(this.__fbsrSentBody || '').get('fb_api_req_friendly_name') || '?'; } catch (e) { /* ignore */ }
            if (window.__feedBodies.length >= 50) window.__feedBodies.shift();
            window.__feedBodies.push({ friendlyName: name, size: this.responseText.length, text: this.responseText, via: 'xhr' });
          } catch (e) { /* ignore */ }
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ── fetch patch ─────────────────────────────────────────────────────────────
  // The extension's own callGraphQL uses fetch(), so the XHR patch above never
  // sees those calls. We also patch fetch so __feedBodies captures everything,
  // and so future debugging sees responses regardless of how FB issued them.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isGraphQL = url.indexOf('/api/graphql') !== -1;
    const sentBody = init && init.body;
    const p = origFetch.apply(this, arguments);
    if (!isGraphQL) return p;
    return p.then(async (res) => {
      try {
        const clone = res.clone();
        const text = await clone.text();
        try { onGraphQLResponse(text); } catch (e) { /* ignore */ }
        if (window.__FBSR_DEBUG) {
          if (!window.__feedBodies) window.__feedBodies = [];
          let name = '?';
          try { name = new URLSearchParams(typeof sentBody === 'string' ? sentBody : '').get('fb_api_req_friendly_name') || '?'; } catch (e) { /* ignore */ }
          if (window.__feedBodies.length >= 50) window.__feedBodies.shift();
          window.__feedBodies.push({ friendlyName: name, size: text.length, text, via: 'fetch' });
        }
      } catch (e) { /* ignore */ }
      return res;
    });
  };

  console.log('[FBSR] intercept installed' + (window.__FBSR_DEBUG ? ' [debug]' : ''));
})();

// ─── Main ─────────────────────────────────────────────────────────────────────
function fbsrMain() {
  const DEBUG = window.__FBSR_DEBUG;
  const log = (...a) => { if (DEBUG) console.log('[FBSR]', ...a); };
  const warn = (...a) => { if (DEBUG) console.warn('[FBSR]', ...a); };
  const err = (...a) => { console.error('[FBSR]', ...a); };

  // ── Tokens ──────────────────────────────────────────────────────────────────
  let tokens = null;

  function getTokens() {
    if (tokens) return tokens;
    const html = document.documentElement.innerHTML;
    const fbDtsg = (html.match(/"DTSGInitData",\[\],\{"token":"([^"]+)"/) || [])[1] ||
      (html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || [])[1] ||
      (html.match(/name="fb_dtsg" value="([^"]+)"/) || [])[1];
    const lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1];
    const userId = (document.cookie.match(/c_user=(\d+)/) || [])[1];
    if (!fbDtsg || !userId) return null;
    const jazoest = '2' + [...fbDtsg].reduce((s, c) => s + c.charCodeAt(0), 0);
    tokens = { fbDtsg, lsd: lsd || '', userId, jazoest };
    return tokens;
  }

  if (!getTokens()) { err('no tokens — are you logged in?'); return; }

  // ── GraphQL ─────────────────────────────────────────────────────────────────

  async function callGraphQL(friendlyName, docId, variables) {
    const t = getTokens();
    if (!t) throw new Error('no tokens');
    const body = new URLSearchParams({
      av: t.userId, __user: t.userId, __a: '1', __req: '1',
      fb_dtsg: t.fbDtsg, jazoest: t.jazoest, lsd: t.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: friendlyName,
      server_timestamps: 'true',
      variables: JSON.stringify(variables),
      doc_id: docId,
    });
    const res = await fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': friendlyName, 'x-fb-lsd': t.lsd },
      body: body.toString(),
    });
    const text = await res.text();
    const json = JSON.parse(text.replace(/^for \(;;\);/, '').split('\n')[0]);
    log(`← ${friendlyName}`, json.errors ? { errors: json.errors } : 'ok');
    return json;
  }

  // Shared relay provider flags (required by FB's query schema)
  const RELAY_VARS = {
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
  };

  function queryTooltip(target) {
    return callGraphQL('CometUFISharesCountTooltipContentQuery', '9843821265734688',
      { feedbackTargetID: target });
  }

  function queryDialog(target) {
    return callGraphQL('CometResharesDialogQuery', '26194058653607577', {
      count: 10, feedbackID: target, feedbackSource: 1,
      feedLocation: 'SHARE_OVERLAY', privacySelectorRenderLocation: 'COMET_STREAM',
      renderLocation: 'reshares_dialog', scale: 1, ...RELAY_VARS,
    });
  }

  function queryPagination(feedbackBase64Id, cursor) {
    return callGraphQL('CometResharesFeedPaginationQuery', '36071431812455144', {
      count: 10, cursor, feedLocation: 'SHARE_OVERLAY', feedbackSource: 1,
      focusCommentID: null, privacySelectorRenderLocation: 'COMET_STREAM',
      referringStoryRenderLocation: null, renderLocation: 'reshares_dialog',
      scale: 1, useDefaultActor: false, id: feedbackBase64Id, ...RELAY_VARS,
    });
  }

  // ── Post identification ──────────────────────────────────────────────────────
  // Returns a feedback target for the given post container, or null.

  function getFeedbackTarget(article) {
    // Standalone pages: target comes from the URL (one post per page)
    const path = location.pathname;
    if (path.startsWith('/watch')) {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return v;
    }
    if (path.startsWith('/photo')) {
      const fbid = new URLSearchParams(location.search).get('fbid');
      if (fbid) return fbid;
    }
    if (path.startsWith('/reel/')) {
      const m = path.match(/^\/reel\/(\d+)/);
      if (m) return m[1];
    }

    const html = article.outerHTML;

    // 1. pfbid in DOM (simple regex — fast path, works for most posts)
    const pfbid = html.match(/pfbid[A-Za-z0-9]+/);
    if (pfbid) return pfbid[0];

    // 2. Group post: explicit numeric id in permalink
    const groupPost = html.match(/\/groups\/[^/]+\/posts\/(\d+)/);
    if (groupPost) return groupPost[1];

    const map = window.__fbsrPfbidMap;
    if (!map || !map.size) return null;

    // 3. Group composite key from /groups/<id>/user/<uid>/ DOM links
    const groupUser = html.match(/\/groups\/(\d+)\/user\/(\d+)\//);
    if (groupUser) {
      const t = map.get(`group:${groupUser[1]}:${groupUser[2]}`);
      if (t) return t;
    }

    // 4. Any long numeric ID in the DOM matched against pfbidMap
    for (const id of new Set(html.match(/\b\d{14,20}\b/g) || [])) {
      const t = map.get(id);
      if (t) return t;
    }

    return null;
  }

  // ── Post containers ──────────────────────────────────────────────────────────

  function findPostContainers(root) {
    root = root || document;
    const containers = new Set();
    const isStandalone = /^\/(watch|photo|reel\/)/.test(location.pathname);

    for (const sb of root.querySelectorAll('[data-ad-rendering-role="share_button"]')) {
      let el = sb;
      let found = false;
      for (let i = 0; i < 15 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.querySelector('[data-ad-rendering-role="story_message"]') ||
          el.querySelector('[data-ad-preview="message"]') ||
          el.querySelector('[aria-label^="Actions for this post"]')) {
          containers.add(el);
          found = true;
          break;
        }
      }
      // Standalone-page fallback: use the action-row ancestor
      if (!found && isStandalone) {
        let cur = sb;
        for (let i = 0; i < 6 && cur; i++) {
          cur = cur.parentElement;
          if (!cur) break;
          if (cur.querySelectorAll('[role="button"][aria-label]').length >= 2) {
            containers.add(cur);
            break;
          }
        }
      }
    }
    return [...containers];
  }

  // ── Retry infrastructure ─────────────────────────────────────────────────────

  const processed = new WeakSet();
  const retryScheduled = new WeakSet();
  const hydrationWatched = new WeakSet();
  let postCounter = 0;

  function setupRetry(article, idx) {
    // MutationObserver: re-run when an outer pfbid hydrates into the DOM.
    // "Outer" means NOT inside a <blockquote> (the embedded original's wrapper)
    // so hovering the embedded post doesn't incorrectly trigger re-processing.
    if (!hydrationWatched.has(article)) {
      hydrationWatched.add(article);
      let fired = false;
      const mo = new MutationObserver(() => {
        if (fired) return;
        let hasOuterPfbid = false;
        for (const a of article.querySelectorAll('a[href*="pfbid"]')) {
          let inBQ = false, p = a.parentElement;
          while (p && p !== article) { if (p.tagName === 'BLOCKQUOTE') { inBQ = true; break; } p = p.parentElement; }
          if (!inBQ) { hasOuterPfbid = true; break; }
        }
        if (!hasOuterPfbid && !/\/groups\/[^/]+\/posts\/\d+/.test(article.outerHTML)) return;
        fired = true;
        mo.disconnect();
        log(`#${idx}: hydration detected, re-processing`);
        processed.delete(article);
        processPost(article);
      });
      mo.observe(article, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }

    // IntersectionObserver: retry after a delay when post re-enters viewport
    if (!retryScheduled.has(article)) {
      retryScheduled.add(article);
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.disconnect();
          setTimeout(() => { processed.delete(article); processPost(article); }, 1500);
          break;
        }
      }, { threshold: 0.3 });
      io.observe(article);
    }
  }

  // ── processPost ──────────────────────────────────────────────────────────────

  async function processPost(article) {
    if (processed.has(article)) return;
    // Skip comment/reply articles
    const aria = article.getAttribute('aria-label') || '';
    if (/^(Comment|Reply) by/i.test(aria)) return;
    processed.add(article);

    const idx = ++postCounter;
    const target = getFeedbackTarget(article);

    if (!target) {
      log(`#${idx}: no target, will retry on hydration`);
      processed.delete(article);
      setupRetry(article, idx);
      return;
    }

    log(`#${idx}: target = ${String(target).slice(0, 30)}…`);

    // Share count: use cache or fall back to API
    const scMap = window.__fbsrShareCountMap;
    let count = scMap && scMap.get(target);
    if (typeof count !== 'number') {
      try {
        const data = await queryTooltip(target);
        count = data && data.data && data.data.feedback &&
          data.data.feedback.reshares && data.data.feedback.reshares.count;
      } catch (e) {
        err(`#${idx}: tooltip query failed`, e);
        return;
      }
    }

    if (!count || count <= 0) {
      log(`#${idx}: ${count} shares, skipping`);
      return;
    }

    injectLink(article, target, count, idx);
  }

  // ── injectLink ───────────────────────────────────────────────────────────────

  function injectLink(article, target, count, idx) {
    if (article.querySelector('.fbsr-link-container')) return;

    log(`#${idx}: injecting "${count} share${count !== 1 ? 's' : ''}"`);

    const wrap = document.createElement('div');
    wrap.className = 'fbsr-link-container';

    const link = document.createElement('a');
    link.className = 'fbsr-link';
    link.href = '#';
    link.textContent = count === 1 ? '1 share' : `${count} shares`;

    // ── Tooltip ──────────────────────────────────────────────────────────────
    let tooltipEl = null;
    let tooltipData = null;
    let tooltipFetchDone = false;

    async function loadTooltipData() {
      if (tooltipFetchDone) return;
      tooltipFetchDone = true;
      try {
        const data = await queryTooltip(target);
        tooltipData = data && data.data && data.data.feedback &&
          data.data.feedback.legacy_resharers || [];
      } catch (e) {
        tooltipData = [];
      }
      if (tooltipEl) renderTooltip(tooltipEl, tooltipData, count);
    }

    function renderTooltip(el, resharers, total) {
      el.innerHTML = '';
      if (!resharers || !resharers.length) {
        const s = document.createElement('span');
        s.className = 'fbsr-tooltip-loading';
        s.textContent = total > 0 ? 'No visible sharers' : 'No shares';
        el.appendChild(s);
        return;
      }
      for (const r of resharers) {
        const n = document.createElement('span');
        n.className = 'fbsr-tooltip-name';
        n.textContent = r.name;
        el.appendChild(n);
      }
      if (resharers.length < total) {
        const more = document.createElement('span');
        more.className = 'fbsr-tooltip-name';
        more.style.color = '#65676b';
        more.textContent = `and ${total - resharers.length} more`;
        el.appendChild(more);
      }
    }

    function showTooltip() {
      if (tooltipEl) return;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'fbsr-tooltip';
      if (tooltipData) {
        renderTooltip(tooltipEl, tooltipData, count);
      } else {
        const s = document.createElement('span');
        s.className = 'fbsr-tooltip-loading';
        s.textContent = 'Loading…';
        tooltipEl.appendChild(s);
        loadTooltipData();
      }
      document.body.appendChild(tooltipEl);
      positionTooltip(tooltipEl, link);
      attachTooltipDismiss();
    }

    function hideTooltip() {
      if (!tooltipEl) return;
      try { tooltipEl.__cleanup && tooltipEl.__cleanup(); } catch (e) { /* ignore */ }
      tooltipEl.remove();
      tooltipEl = null;
    }

    function positionTooltip(el, anchor) {
      const r = anchor.getBoundingClientRect();
      let top = window.scrollY + r.bottom + 6;
      let left = window.scrollX + r.left;
      const elW = el.offsetWidth || 260;
      if (left + elW > window.scrollX + window.innerWidth - 8) {
        left = window.scrollX + window.innerWidth - elW - 8;
      }
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    }

    function attachTooltipDismiss() {
      const onOutsideClick = (e) => {
        if (!tooltipEl || tooltipEl.contains(e.target) || link.contains(e.target)) return;
        hideTooltip();
      };
      const onEsc = (e) => { if (e.key === 'Escape') hideTooltip(); };
      const onScroll = () => hideTooltip();
      // Watchdog: dismiss if FB modal covers our link
      const watchdog = setInterval(() => {
        if (!tooltipEl) { clearInterval(watchdog); return; }
        const r = link.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { hideTooltip(); return; }
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (el && !link.contains(el) && !el.contains(link)) hideTooltip();
      }, 500);
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('scroll', onScroll, { passive: true });
      tooltipEl.__cleanup = () => {
        clearInterval(watchdog);
        document.removeEventListener('click', onOutsideClick, true);
        document.removeEventListener('keydown', onEsc, true);
        window.removeEventListener('scroll', onScroll);
      };
    }

    // Cancel pending show if user clicks something before mouseenter resolves
    link.addEventListener('mouseenter', () => {
      const cancelOnClick = () => { document.removeEventListener('click', cancelOnClick, true); };
      document.addEventListener('click', cancelOnClick, true);
      showTooltip();
    });
    link.addEventListener('mouseleave', hideTooltip);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
      openModal(target, count);
    });

    wrap.appendChild(link);
    placeLink(article, wrap, idx);
  }

  // ── placeLink ────────────────────────────────────────────────────────────────

  function placeLink(article, wrap, idx) {
    const shareBtn = article.querySelector('[data-ad-rendering-role="share_button"]');
    if (!shareBtn) { article.appendChild(wrap); return; }

    let row = shareBtn;
    for (let i = 0; i < 10 && row; i++) {
      row = row.parentElement;
      if (!row || row === article) break;
      if (row.querySelector('[aria-label="Like"]') &&
        row.querySelector('[aria-label="Leave a comment"]') &&
        row.querySelector('[data-ad-rendering-role="share_button"]') &&
        !row.querySelector('[contenteditable="true"]')) {
        row.appendChild(wrap);
        return;
      }
    }
    warn(`#${idx}: could not find action row, appending to article`);
    article.appendChild(wrap);
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  function openModal(target, shareCount) {
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
    const initStatus = document.createElement('div');
    initStatus.className = 'fbsr-modal-status';
    initStatus.textContent = 'Loading…';
    body.appendChild(initStatus);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Scroll lock
    const scrollY = window.scrollY;
    const prevStyle = {
      position: document.body.style.position, top: document.body.style.top,
      left: document.body.style.left, right: document.body.style.right, width: document.body.style.width,
    };
    Object.assign(document.body.style, { position: 'fixed', top: `-${scrollY}px`, left: '0', right: '0', width: '100%' });

    function close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      Object.assign(document.body.style, prevStyle);
      window.scrollTo(0, scrollY);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);

    // Pagination state
    const rendered = new Set();
    let nextCursor = null;
    let feedbackBase64Id = null;
    let firstPageLoaded = false;
    let hasMore = true;
    let loading = false;
    let totalRendered = 0;
    let sentinel = null;
    let io = null;

    function showStatus(text) {
      const s = document.createElement('div');
      s.className = 'fbsr-modal-status';
      s.textContent = text;
      body.appendChild(s);
      return s;
    }

    function renderEdges(edges) {
      for (const edge of (edges || [])) {
        const id = edge && edge.node && edge.node.id;
        if (id && rendered.has(id)) continue;
        if (id) rendered.add(id);
        const card = buildSharerCard(edge);
        if (card) { body.appendChild(card); totalRendered++; }
      }
    }

    async function loadMore() {
      if (loading || !hasMore) {
        log(`modal loadMore: skip (loading=${loading}, hasMore=${hasMore})`);
        return;
      }
      loading = true;
      const loadingEl = sentinel ? null : showStatus('Loading sharers…');
      try {
        const prevCursor = nextCursor;
        let reshares;
        if (!firstPageLoaded) {
          const data = await queryDialog(target);
          feedbackBase64Id = data && data.data && data.data.feedback && data.data.feedback.id || null;
          reshares = data && data.data && data.data.feedback && data.data.feedback.reshares;
          firstPageLoaded = true;
        } else {
          if (!feedbackBase64Id || !nextCursor) {
            log(`modal loadMore: missing id/cursor (id=${!!feedbackBase64Id}, cursor=${!!nextCursor})`);
            hasMore = false;
          } else {
            const data = await queryPagination(feedbackBase64Id, nextCursor);
            reshares = (data && data.data && data.data.node && data.data.node.reshares) ||
              (data && data.data && data.data.feedback && data.data.feedback.reshares);
            if (!reshares) {
              log('modal loadMore: pagination response has no reshares', JSON.stringify(data?.data || {}).slice(0, 200));
            }
          }
        }

        const edges = reshares && reshares.edges || [];
        const pageInfo = reshares && (reshares.page_info || reshares.pageInfo) || {};
        nextCursor = pageInfo.end_cursor || pageInfo.endCursor || null;
        const advanced = nextCursor && nextCursor !== prevCursor;
        const reportedHN = pageInfo.has_next_page !== undefined ? pageInfo.has_next_page : pageInfo.hasNextPage;
        hasMore = edges.length > 0 && !!advanced && reportedHN !== false;
        log(`modal loadMore: edges=${edges.length} advanced=${!!advanced} reportedHN=${reportedHN} hasMore=${hasMore} totalRendered=${totalRendered + edges.length}`);

        if (loadingEl) loadingEl.remove();
        if (sentinel) { sentinel.remove(); sentinel = null; }
        renderEdges(edges);

        if (totalRendered === 0 && !hasMore) {
          showStatus(shareCount > 0 ? 'No visible sharers (some may be private).' : 'No one has shared this post.');
          return;
        }
        if (totalRendered < shareCount && !hasMore) {
          const hidden = shareCount - totalRendered;
          showStatus(`${hidden} sharer${hidden === 1 ? '' : 's'} hidden by privacy settings.`);
          return;
        }
        if (hasMore) {
          sentinel = showStatus('Loading more…');
          // Recreate IO each time to avoid any quirks with re-observing after
          // the previous sentinel was removed from DOM.
          if (io) io.disconnect();
          io = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
              log('modal: sentinel intersecting, calling loadMore');
              loadMore();
            }
          }, { root: body, threshold: 0.1 });
          io.observe(sentinel);
          // If the modal body still has no scroll (sentinel is visible from
          // the start), the IntersectionObserver won't reliably re-fire for
          // each new sentinel we create. Proactively schedule the next load
          // so we keep fetching until the body fills up.
          if (body.scrollHeight <= body.clientHeight) {
            setTimeout(loadMore, 100);
          }
        }
      } catch (e) {
        err('modal load failed', e);
        if (loadingEl) loadingEl.remove();
        if (sentinel) { sentinel.remove(); sentinel = null; }
        showStatus('Failed to load sharers.');
      } finally {
        loading = false;
      }
    }

    // Scroll-based fallback: IntersectionObserver can be unreliable when
    // sentinels are rapidly created/removed. Trigger loadMore when the user
    // scrolls within 200px of the body's bottom.
    body.addEventListener('scroll', () => {
      if (!hasMore || loading) return;
      const distFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
      if (distFromBottom < 200) {
        log(`modal: scroll near bottom (dist=${distFromBottom}), calling loadMore`);
        loadMore();
      }
    }, { passive: true });

    // Disconnect IntersectionObserver when modal closes
    const origRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = () => { if (io) { io.disconnect(); io = null; } origRemove(); };

    body.innerHTML = '';
    loadMore();
  }

  // ── Sharer card ──────────────────────────────────────────────────────────────

  function buildSharerCard(edge) {
    const node = edge.node;
    const shareStory = node && node.comet_sections && node.comet_sections.context_layout && node.comet_sections.context_layout.story;
    if (!shareStory) { warn('buildSharerCard: missing context_layout.story'); return null; }
    const actor = shareStory.comet_sections && shareStory.comet_sections.actor_photo &&
      shareStory.comet_sections.actor_photo.story && shareStory.comet_sections.actor_photo.story.actors &&
      shareStory.comet_sections.actor_photo.story.actors[0];
    if (!actor) { warn('buildSharerCard: missing actor'); return null; }

    let creationTime = null, privacyDesc = null, privacyIconName = null;
    for (const m of (shareStory.comet_sections && shareStory.comet_sections.metadata || [])) {
      if (m.__typename === 'CometFeedStoryLongerTimestampStrategy' && m.story && m.story.creation_time) {
        creationTime = m.story.creation_time;
      } else if (m.__typename === 'CometFeedStoryAudienceStrategy' && m.story && m.story.privacy_scope) {
        privacyDesc = m.story.privacy_scope.description;
        privacyIconName = m.story.privacy_scope.icon_image && m.story.privacy_scope.icon_image.name;
      }
    }

    const captionText = node.comet_sections && node.comet_sections.content && node.comet_sections.content.story &&
      node.comet_sections.content.story.comet_sections && node.comet_sections.content.story.comet_sections.message &&
      node.comet_sections.content.story.comet_sections.message.story &&
      node.comet_sections.content.story.comet_sections.message.story.message &&
      node.comet_sections.content.story.comet_sections.message.story.message.text;
    const hasAttachment = !!(node.attachments && node.attachments.length ||
      node.comet_sections && node.comet_sections.content && node.comet_sections.content.story &&
      node.comet_sections.content.story.attachments && node.comet_sections.content.story.attachments.length ||
      node.attached_story);
    const profileHref = actor.profile_url || actor.url || '#';
    const postHref = node.permalink_url || '#';

    const card = document.createElement('div');
    card.className = 'fbsr-sharer-card';

    const cardHeader = document.createElement('div');
    cardHeader.className = 'fbsr-sharer-header';

    const avatarLink = document.createElement('a');
    avatarLink.href = profileHref; avatarLink.target = '_blank'; avatarLink.rel = 'noopener noreferrer';
    avatarLink.className = 'fbsr-sharer-avatar-link';
    const img = document.createElement('img');
    img.className = 'fbsr-sharer-avatar';
    img.src = actor.profile_picture && actor.profile_picture.uri || '';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    avatarLink.appendChild(img);

    const info = document.createElement('div');
    info.className = 'fbsr-sharer-info';

    const nameLink = document.createElement('a');
    nameLink.className = 'fbsr-sharer-name'; nameLink.href = profileHref;
    nameLink.target = '_blank'; nameLink.rel = 'noopener noreferrer';
    nameLink.textContent = actor.name;

    // Title trail (e.g. "shared a memory.")
    const titleText = shareStory.comet_sections && shareStory.comet_sections.title &&
      shareStory.comet_sections.title.story && shareStory.comet_sections.title.story.title &&
      shareStory.comet_sections.title.story.title.text;
    if (titleText && titleText.indexOf(actor.name) === 0) {
      const trailing = titleText.slice(actor.name.length).trim();
      if (trailing) {
        const trail = document.createElement('span');
        trail.className = 'fbsr-sharer-title-trail';
        trail.textContent = ' ' + trailing;
        nameLink.appendChild(trail);
      }
    }
    info.appendChild(nameLink);

    const metaRow = document.createElement('div');
    metaRow.className = 'fbsr-sharer-meta';
    if (creationTime) {
      const ts = document.createElement('a');
      ts.className = 'fbsr-sharer-timestamp'; ts.href = postHref;
      ts.target = '_blank'; ts.rel = 'noopener noreferrer';
      ts.textContent = formatRelativeTime(creationTime);
      metaRow.appendChild(ts);
    }
    if (privacyIconName || privacyDesc) {
      if (creationTime) { const dot = document.createElement('span'); dot.textContent = ' · '; metaRow.appendChild(dot); }
      const pIcon = document.createElement('span');
      pIcon.className = 'fbsr-sharer-privacy'; pIcon.title = privacyDesc || '';
      pIcon.textContent = privacyGlyph(privacyIconName);
      metaRow.appendChild(pIcon);
    }
    if (metaRow.childNodes.length) info.appendChild(metaRow);

    if (captionText) {
      const caption = document.createElement('div');
      caption.className = 'fbsr-sharer-caption';
      caption.textContent = captionText;
      info.appendChild(caption);
    }

    cardHeader.appendChild(avatarLink);
    cardHeader.appendChild(info);
    card.appendChild(cardHeader);

    // Show Attachment → original post
    const attachedStory = (node && node.attached_story) ||
      (node && node.comet_sections && node.comet_sections.content &&
        node.comet_sections.content.story && node.comet_sections.content.story.attached_story);
    const originalHref = attachedStory && (attachedStory.permalink_url || attachedStory.url);
    if (hasAttachment && originalHref) {
      const btn = document.createElement('a');
      btn.className = 'fbsr-sharer-attachment-btn'; btn.href = originalHref;
      btn.target = '_blank'; btn.rel = 'noopener noreferrer'; btn.textContent = 'Show Attachment';
      card.appendChild(btn);
    }

    return card;
  }

  function privacyGlyph(name) {
    switch (name) {
      case 'globe': case 'everyone': case 'public': return '🌐';
      case 'friends': return '👥';
      case 'only_me': case 'lock': return '🔒';
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

  // ── Inline-script seeding ────────────────────────────────────────────────────
  // FB server-renders the first batch of posts as inline JSON. We parse them
  // here so the pfbidMap is populated before the user interacts with anything.

  function seedFromInlineScripts() {
    if (window.__FBSR_DISABLE_SEEDING || typeof window.__fbsrIndexObject !== 'function') return;
    let added = 0;
    for (const s of document.querySelectorAll('script:not([src])')) {
      const txt = s.textContent;
      if (!txt || txt.length < 1000) continue;
      if (txt.indexOf('post_id') === -1) continue;
      if (txt.indexOf('pfbid') === -1 && txt.indexOf('permalink_url') === -1) continue;
      try { added += window.__fbsrIndexObject(JSON.parse(txt)); } catch (e) { /* not JSON, skip */ }
    }
    if (added) log(`seeded ${added} entries from inline scripts`);
  }

  // ── Scan & observe ───────────────────────────────────────────────────────────

  function scanPosts() {
    findPostContainers().forEach(processPost);
  }

  let mapRescanTimer = null;
  window.__fbsrOnMapUpdate = () => {
    if (mapRescanTimer) return;
    mapRescanTimer = setTimeout(() => { mapRescanTimer = null; scanPosts(); }, 250);
  };

  const observer = new MutationObserver((mutations) => {
    const containers = new Set();
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        findPostContainers(node).forEach(c => containers.add(c));
        if (node.querySelector && node.querySelector('[data-ad-rendering-role="share_button"]')) {
          findPostContainers(node.parentElement || node).forEach(c => containers.add(c));
        }
      }
    }
    if (mutations.length > 0) {
      findPostContainers().forEach(c => { if (!processed.has(c)) containers.add(c); });
    }
    containers.forEach(processPost);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA navigation
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      log('navigation:', lastUrl, '→', location.href);
      lastUrl = location.href;
      setTimeout(seedFromInlineScripts, 600);
      setTimeout(scanPosts, 500);
    }
  }, 1000);

  // Initial seed + scan
  setTimeout(seedFromInlineScripts, 100);
  setTimeout(seedFromInlineScripts, 2000);
  setTimeout(scanPosts, 1500);

  log('ready');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fbsrMain, { once: true });
} else {
  fbsrMain();
}