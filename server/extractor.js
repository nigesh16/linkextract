// Ported from the latest working Google Apps Script (Code.gs). Parsing and page-structure logic are the same;
// only the plumbing is new: fetch() instead of UrlFetchApp, one result object per URL instead of sheet cells,
// and Published Date formatted in the time zone chosen in the app (the original timestamp is also returned).
//
// How the main post is told apart from everything else on the page:
//  - analyze_() finds the page regions that do NOT belong to the main post: embedded / reshared / quoted
//    posts, the comments list, and the media regions of video, external-article and document previews.
//  - Engagement counts, followers and content are read only from outside the nested / comments regions.
//  - An image becomes the Banner Image only if it lies outside all of those regions, is not wrapped in an
//    external link, is not a video poster, and is either inside a recognised image-attachment block or the
//    page carries no other media at all. Anything ambiguous leaves the field empty.

const REQUIRE_IMAGE_BLOCK_MARKER = false; // true = accept ONLY images inside a recognised image-attachment block
const INFER_ZERO_LIKES_WHEN_NO_COUNTER = true;  // see note above finish_(); false = leave Likes empty instead
const FETCH_TIMEOUT_MS = 20000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};
const POST_TYPES = ['socialmediaposting', 'discussionforumposting', 'article', 'newsarticle', 'blogposting'];

// ---- Page-structure markers (class / attribute names inside opening tags). ----
const IMG_SCAN_RE = /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s<>\\]*/gi;
const IMG_TYPE_RE = /\/dms\/image\/(?:v2\/)?[^\/?]+\/([^\/?]+)\//i;
const IMG_TYPE_REJECT_RE = /video|document|pdf|article|cover|logo|profile|company|school|avatar|sponsor|icon|badge/i;
const IMAGE_BLOCK_RE = /feed-images-content|share-images|update-components-image|images-content|multi-image|image-carousel|feed-image\b/i;
const VIDEO_BLOCK_RE = /feed-video|video-js|vjs-|videocover|video-player|update-components-linkedin-video|data-sources=/i;
const ARTICLE_BLOCK_RE = /public_post_feed-article|article-content|feed-article|link-preview|articleshare|external-link|update-components-article|share-article/i;
const DOC_BLOCK_RE = /document-cover|feed-document|document-viewer|document-container|pdf-viewer|update-components-document/i;
const NESTED_BLOCK_RE = /reshared-post|reshared-update|reshare-update|feed-reshare|main-feed-activity-card__reshare|embedded-update|nested-update|update-components-mini-update|feed-shared-mini-update|mini-update|quoted-post/i;
const COMMENTS_BLOCK_RE = /(?<![\w-])(?:comments-list|comment__list)(?![\w-])|data-test-id="main-feed-activity-card__comments|<section\b[^>]*class="(?:[^"]*\s)?comments(?:\s[^"]*)?"/i;
const URN_ATTR_RE = /\b(?:data-urn|data-id|data-activity-urn|data-entity-urn|data-semaphore-content-urn|data-attribute1|data-li-urn)="urn:li:(?:activity|share|ugcPost):(\d{15,20})"/gi;

// ---- Engagement-count patterns, in priority order ----
const LIKE_PATTERNS = [
  /data-num-(?:reactions?|likes?)="([\d.,KkMm]+)"/i,
  /data-test-id="social-actions__reaction-count"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)/i,
  /aria-label="([\d][\d.,]*[KkMm]?)\s+(?:reactions?|likes?)"/i,
  /"(?:numLikes|numReactions|reactionCount|likeCount)"\s*:\s*"?(\d+)"?/i,
  /class="[^"]*(?:reaction|like)[^"]*count[^"]*"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)\s*</i,
  /class="[^"]*count[^"]*(?:reaction|like)[^"]*"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)\s*</i,
  /(?<![\w.,-])(\d[\d.,]*[KkMm]?)\s*(?:<[^>]*>\s*){0,3}(?:reactions?|likes?)\b/i
];
const COMMENT_PATTERNS = [
  /data-num-comments="([\d.,KkMm]+)"/i,
  /data-test-id="social-actions__comments"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)/i,
  /aria-label="([\d][\d.,]*[KkMm]?)\s+comments?"/i,
  /"(?:numComments|commentCount|totalComments)"\s*:\s*"?(\d+)"?/i,
  /class="[^"]*comment[^"]*count[^"]*"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)\s*</i,
  /class="[^"]*count[^"]*comment[^"]*"[^>]*>\s*(?:<[^>]*>\s*)*([\d][\d.,]*[KkMm]?)\s*</i,
  /(?<![\w.,-])(\d[\d.,]*[KkMm]?)\s*(?:<[^>]*>\s*){0,3}comments?\b/i
];
const SHARE_PATTERNS = [
  /data-num-(?:reposts?|shares?)="([\d.,KkMm]+)"/i,
  /"(?:numReposts|numShares|repostCount|shareCount)"\s*:\s*"?(\d+)"?/i,
  /data-test-id="social-actions__(?:reposts?|shares?)[^"]*"[^>]*>\s*([\d.,KkMm]+)/i,
  /aria-label="([\d.,KkMm]+)\s+reposts?"/i,
  /(?<![\w.,-])(\d[\d.,]*[KkMm]?)\s+reposts?\b/i
];

// ===================== FETCH + PIPELINE (replaces run_ / prep_ / retryAlt_ / mergeEmbed_ / finish_) =====================
// One URL = original page -> (one retry through alternate URLs if it was a login wall / no data)
//           -> embed fallback for missing Likes / Comments / image -> result.
export async function extractUrl(raw, timeZone) {
  const input = String(raw).trim();
  const base = {
    url: input, date: '', timestamp: '', image: '', username: '', reach: null, content: '',
    likes: null, comments: null, shares: null, status: 'failed', note: ''
  };
  const fail = note => ({ ...base, note });
  const url = normalizeUrl_(input);
  if (!url) return fail('Not a valid LinkedIn URL');
  base.url = url;

  const j = {
    tz: timeZone, url, rawUrl: /^https?:\/\//i.test(input) ? input : 'https://' + input,
    fromEmbed: [], embedNote: '', altNote: '', retry: false, d: null, embedUrl: '', failNote: ''
  };
  try {
    let ok = prep_(j, await fetchPage_(url));
    if (!ok && j.retry) ok = await retryAlt_(j);
    if (!ok) return fail(j.failNote);

    if (j.embedUrl && needsEmbed_(j.d)) {
      try { mergeEmbed_(j, await fetchPage_(j.embedUrl)); }
      catch (e) { j.embedNote = 'embed error'; }
    }
    return finish_(j, base);
  } catch (e) {
    return fail('Unexpected error - ' + e.message);
  }
}

// Never throws: failures (network, timeout, body read) come back as { error }.
async function fetchPage_(url) {
  try {
    const resp = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (resp.status !== 200) {
      try { await resp.body?.cancel(); } catch (e) {}
      return { status: resp.status, html: '' };
    }
    return { status: 200, html: await resp.text() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Retries a failed row through alternate URLs. Restores the original failure text if nothing works.
async function retryAlt_(j) {
  const first = j.failNote;
  const alts = [];
  if (j.rawUrl && j.rawUrl !== j.url) alts.push(j.rawUrl);
  const urn = urn_(j.url, '');
  if (urn) alts.push('https://www.linkedin.com/feed/update/' + urn + '/');
  for (let i = 0; i < alts.length; i++) {
    if (prep_(j, await fetchPage_(alts[i]))) { j.altNote = 'via alternate URL'; return true; }
  }
  j.failNote = first + ' (alternate URLs also tried)';
  return false;
}

// Parses the original page. Returns false (and sets failNote) if nothing usable.
function prep_(j, resp) {
  j.retry = false;
  if (!resp || resp.error) { j.failNote = 'Network error - ' + (resp ? resp.error : 'no response'); return false; }
  const code = resp.status;
  if (code !== 200) {
    j.failNote = (code === 999 || code === 401 || code === 403) ? `Blocked by LinkedIn (HTTP ${code})`
      : (code === 404 || code === 410) ? `Post not found (HTTP ${code})`
      : `HTTP ${code}`;
    return false;
  }
  const html = resp.html;
  let d;
  try { d = parsePost_(html, j.url); } catch (e) { j.failNote = 'Parse error - ' + e.message; return false; }

  const any = d.user || d.content || d.image || d.likes !== null || d.comments !== null ||
              d.reach !== null || d.shares !== null || (d.date && !d.dateDerived);
  if (!any) {
    j.failNote = (/authwall|uas\/login|Sign in to view/i.test(html) || isGenericPage_(html))
      ? 'LinkedIn login wall' : 'No post data in HTML';
    j.retry = !j.altNote;   // eligible for the alternate-URL retry (once)
    return false;
  }
  j.d = d;
  const urn = urn_(j.url, html);
  j.embedUrl = urn ? 'https://www.linkedin.com/embed/feed/update/' + urn : '';
  return true;
}

function needsEmbed_(d) { return d.likes === null || d.comments === null || !d.image; }

// Embed data fills ONLY fields that are still missing; nothing from the original page is overwritten.
function mergeEmbed_(j, resp) {
  if (!resp || resp.error) { j.embedNote = 'embed fetch error'; return; }
  if (resp.status !== 200) { j.embedNote = 'embed unavailable (HTTP ' + resp.status + ')'; return; }
  let e;
  try { e = parseEmbed_(resp.html, j.embedUrl, j.d); }
  catch (err) { j.embedNote = 'embed parse error'; return; }
  const d = j.d;
  if (d.likes === null && e.likes !== null) { d.likes = e.likes; j.fromEmbed.push('Likes'); }
  if (d.comments === null && e.comments !== null) { d.comments = e.comments; j.fromEmbed.push('Comments'); }
  if (!d.image && e.image) { d.image = e.image; j.fromEmbed.push('Image'); }
}

// Same boundary rules as the original page. If the original page showed video / article / document / nested
// media, the embed image must additionally sit inside a recognised image-attachment block (strict mode), and
// assets already rejected on the original page stay rejected.
function parseEmbed_(html, embedUrl, orig) {
  const ld = findLd_(html);
  const ctx = analyze_(html, mainIds_(embedUrl, html, ld));
  const c = counts_(ld, html, ctx);
  const im = image_(ld, html, ctx, { given: orig.rejectKeys, strict: !!orig.mediaDirty });
  return { likes: c.likes, comments: c.comments, image: im.url };
}

// Likes are read from the page whenever LinkedIn renders a reaction counter. When a post has zero reactions
// LinkedIn renders NO counter at all, and as soon as there is one reaction the counter appears. So Likes becomes 0
// ONLY when all of these hold: the original page is a real post page with a Like/Comment action bar, it
// exposes an explicit comment count, and neither the page nor the embed shows any reaction counter.
// The note then says the zero was inferred. Set INFER_ZERO_LIKES_WHEN_NO_COUNTER = false to leave Likes empty.
function finish_(j, base) {
  const d = j.d;
  let inferred = '';
  if (INFER_ZERO_LIKES_WHEN_NO_COUNTER && d.likes === null && d.comments !== null && d.socialBar &&
      j.fromEmbed.indexOf('Comments') === -1) {
    d.likes = 0;
    inferred = 'Likes=0 inferred (no reaction counter shown)';
  }
  let content = d.content;
  if (content && content.length > 49000) content = content.slice(0, 49000) + '\n[...truncated]';

  const missing = [['Date', d.date], ['Username', d.user], ['Content', content],
                   ['Likes', d.likes], ['Comments', d.comments]]
    .filter(c => c[1] === null || c[1] === undefined || c[1] === '').map(c => c[0]);

  const note = [
    missing.length ? 'Missing ' + missing.join(', ') : '',
    d.reach === null ? 'Reach (followers) not available' : '',
    j.fromEmbed.length ? 'from embed: ' + j.fromEmbed.join(', ') : '',
    inferred, j.altNote, j.embedNote
  ].filter(Boolean).join(' · ');

  return {
    ...base,
    date: fmtDate_(d.date, j.tz), timestamp: d.date ? d.date.toISOString() : '',
    image: d.image || '', username: d.user || '', reach: d.reach, content: content || '',
    likes: d.likes, comments: d.comments, shares: d.shares,
    status: missing.length ? 'partial' : 'success', note
  };
}

// ===================== PUBLISHED DATE (time zone chosen in the app) =====================
// Valid IANA zone from the request, else the TIMEZONE env var, else UTC (never throws).
function resolveTz_(tz) {
  for (const c of [tz, process.env.TIMEZONE, 'UTC']) {
    if (!c) continue;
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(c) }); return String(c); } catch (e) {}
  }
  return 'UTC';
}

// Formats the (unchanged) Date in the chosen IANA zone; DST is applied by Intl for that exact moment.
export function fmtDate_(d, tz) {
  if (!d) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: resolveTz_(tz)
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year}`;
}

function normalizeUrl_(raw) {
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const m = u.match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
  if (!m) return '';
  const host = m[1].toLowerCase();
  if (!/(^|\.)linkedin\.com$/.test(host) && host !== 'lnkd.in') return '';
  return 'https://' + host + m[2];
}

// Builds urn:li:<activity|share|ugcPost>:<id> from the URL, canonical link, or page.
function urn_(url, html) {
  const canon = (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
  const pats = [/urn:li:(activity|share|ugcPost):(\d{15,20})/i, /(?:^|[-_\/])(activity|share|ugcPost)-(\d{15,20})/i];
  const srcs = [String(url), decode_(canon), html];
  for (const s of srcs) {
    for (const p of pats) {
      const m = s.match(p);
      if (m) {
        const t = m[1].toLowerCase() === 'ugcpost' ? 'ugcPost' : m[1].toLowerCase();
        return 'urn:li:' + t + ':' + m[2];
      }
    }
  }
  return '';
}

// ===================== PARSING =====================
function parsePost_(html, url) {
  const ld = findLd_(html);
  const author = ld ? asArray_(ld.author)[0] : null;
  const authorObj = (typeof author === 'string') ? { name: author } : author;
  const ctx = analyze_(html, mainIds_(url, html, ld));
  const counts = counts_(ld, html, ctx);
  const date = date_(ld, html, url);
  const img = image_(ld, html, ctx, {});
  return {
    date: date.value, dateDerived: date.derived,
    image: img.url, rejectKeys: img.rejectKeys, mediaDirty: img.dirty,
    socialBar: /social-action-bar|public_post_like-cta/i.test(removeRegions_(html, ctx.excl)),
    user: username_(authorObj, html, ctx),
    reach: followers_(authorObj, html, ctx),
    content: content_(ld, html, ctx),
    likes: counts.likes, comments: counts.comments, shares: counts.shares
  };
}

function findLd_(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const objs = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try { flatten_(JSON.parse(m[1].trim()), objs); } catch (e) {}
  }
  for (const o of objs) {
    const types = asArray_(o['@type']).map(t => String(t).toLowerCase());
    if (types.some(t => POST_TYPES.indexOf(t) !== -1)) return o;
  }
  return null;
}

function flatten_(node, out) {
  if (Array.isArray(node)) { node.forEach(n => flatten_(n, out)); return; }
  if (node && typeof node === 'object') { out.push(node); if (node['@graph']) flatten_(node['@graph'], out); }
}

function statType_(s) {
  const t = s && s.interactionType;
  return !t ? '' : (typeof t === 'string' ? t : String(t['@type'] || ''));
}

function date_(ld, html, url) {
  for (const c of [ld && ld.datePublished, meta_(html, 'article:published_time')]) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime())) return { value: d, derived: false };
  }
  // LinkedIn post IDs are snowflake-style: top bits = ms timestamp.
  const canon = (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
  const d = idDate_(url) || idDate_(canon);
  return d ? { value: d, derived: true } : { value: null, derived: false };
}

function idDate_(text) {
  const m = String(text || '').match(/(?:activity|share|ugcPost)[-:](\d{15,20})/i);
  if (!m) return null;
  try {
    const ms = Number(BigInt(m[1]) >> BigInt(22));
    return (ms > Date.UTC(2003, 0, 1) && ms < Date.now() + 864e5) ? new Date(ms) : null;
  } catch (e) { return null; }
}

function content_(ld, html, ctx) {
  const fromLd = ld && (ld.articleBody || ld.text);
  if (fromLd && text_(fromLd)) return text_(fromLd);
  const re = /<(p|span|div)\b[^>]*class="[^"]*attributed-text-segment-list__content[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (inRegions_(ctx.nested, m.index) || inRegions_(ctx.comments, m.index)) continue;
    const t = text_(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ''));
    if (t) return t;
  }
  if (isGenericPage_(html)) return '';   // LinkedIn's own sign-in / landing text is not post content
  return text_(meta_(html, 'og:description') || meta_(html, 'description'));
}

// True when LinkedIn returned its generic landing / sign-in page instead of the post.
function isGenericPage_(html) {
  const title = clean_(meta_(html, 'og:title') || decode_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
  const desc = clean_(meta_(html, 'og:description') || meta_(html, 'description'));
  return /Manage your professional identity|Build and engage with your professional network/i.test(desc) ||
         /^(?:LinkedIn\s*[:|\-\u2013]\s*)?(?:Log In|Sign In|Sign Up)\b|Sign Up\s*\|\s*LinkedIn|LinkedIn\s*Login/i.test(title);
}

function username_(author, html, ctx) {
  const fromLd = author && clean_(author.name);
  if (fromLd) return fromLd;
  const re = /<a\b[^>]*data-tracking-control-name="public_post_feed-actor-name"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (inRegions_(ctx.nested, m.index) || inRegions_(ctx.comments, m.index)) continue;
    const n = clean_(m[1].replace(/<[^>]+>/g, ''));
    if (n) return n;
  }
  if (isGenericPage_(html)) return '';
  const title = meta_(html, 'og:title') || decode_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const t = clean_(title).match(/^(.+?)\s+(?:on LinkedIn\b|posted on the topic\b)/i);
  return t ? t[1].trim() : '';
}

// "Reach" = the author's follower count.
function followers_(author, html, ctx) {
  if (author) {
    for (const s of asArray_(author.interactionStatistic)) {
      if (/follow/i.test(statType_(s))) { const n = count_(s.userInteractionCount); if (n !== null) return n; }
    }
  }
  return firstCount_(html, [/([\d][\d.,]*\s?[KkMm]?)\s+followers\b/i], ctx.excl);
}

// ===================== COUNTS =====================
// Counts come from the main post only: structured data first, then markup outside nested posts and the
// comments list. Zero is a valid count; a count that is not exposed stays null (never defaulted to 0).
function counts_(ld, html, ctx) {
  const out = { likes: null, comments: null, shares: null };
  if (ld) {
    for (const s of asArray_(ld.interactionStatistic)) {
      const type = statType_(s), n = count_(s.userInteractionCount);
      if (n === null) continue;
      if (/LikeAction|ReactAction/i.test(type) && out.likes === null) out.likes = n;
      else if (/CommentAction/i.test(type) && out.comments === null) out.comments = n;
      else if (/ShareAction|Repost/i.test(type) && out.shares === null) out.shares = n;
    }
    if (out.comments === null && ld.commentCount !== undefined) out.comments = count_(ld.commentCount);
  }
  const X = ctx.excl;
  if (out.likes === null) out.likes = firstCount_(html, LIKE_PATTERNS, X);
  if (out.comments === null) out.comments = firstCount_(html, COMMENT_PATTERNS, X);
  // Reposts: explicit repost/share counts only (attributes, embedded JSON, visible text).
  if (out.shares === null) out.shares = firstCount_(html, SHARE_PATTERNS, X);
  return out;
}

// First numeric match, patterns in priority order, document order within a pattern, skipping excluded regions.
function firstCount_(html, res, excl) {
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
    let m;
    while ((m = g.exec(html)) !== null) {
      if (m[0].length === 0) { g.lastIndex++; continue; }
      if (inRegions_(excl, m.index)) continue;
      const n = count_(m[1]);
      if (n !== null) return n;
    }
  }
  return null;
}

// ===================== PAGE STRUCTURE =====================
// Returns the regions of the page (as [start, end) offsets) that do not belong to the main post's own media/counts.
function analyze_(html, mainIds) {
  const nested = regions_(html, NESTED_BLOCK_RE).concat(otherPostRegions_(html, mainIds));
  let comments = regions_(html, COMMENTS_BLOCK_RE);
  if (!comments.length) { const cut = commentsCut_(html); if (cut > 2000) comments = [[cut, html.length]]; }
  const video = regions_(html, /<video\b/i).concat(regions_(html, VIDEO_BLOCK_RE));
  return {
    nested, comments, video,
    article: regions_(html, ARTICLE_BLOCK_RE),
    doc: regions_(html, DOC_BLOCK_RE),
    imageBlocks: regions_(html, IMAGE_BLOCK_RE),
    nonDom: regions_(html, /<(?:script|code|style|noscript)\b/i),   // JSON blobs etc.: no reliable page context
    excl: nested.concat(comments)
  };
}

// Containers that carry a post URN different from the main post's belong to another (nested / related) post.
function otherPostRegions_(html, mainIds) {
  const g = new RegExp(URN_ATTR_RE.source, 'gi');
  const hits = [];
  let m;
  while ((m = g.exec(html)) !== null) hits.push({ idx: m.index, id: m[1] });
  if (!hits.length) return [];
  let main = null;
  hits.forEach(h => { if (main === null && mainIds.indexOf(h.id) !== -1) main = h.id; });
  if (main === null) main = hits[0].id;           // main post is the first container in document order
  const out = [];
  hits.forEach(h => {
    if (h.id === main || inRegions_(out, h.idx)) return;
    const ext = elementExtent_(html, h.idx);
    if (ext) out.push(ext);
  });
  return out;
}

function mainIds_(url, html, ld) {
  const ids = [];
  const canon = (html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
  [String(url || ''), decode_(canon), meta_(html, 'og:url'), ld ? String(ld.url || ld['@id'] || '') : '']
    .forEach(s => {
      const re = /(?:activity|share|ugcPost)[-:](\d{15,20})/gi;
      let m;
      while ((m = re.exec(s)) !== null) if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
    });
  return ids;
}

// Index where a comments list starts (whole class names only, so "social-counts-comments" does not match).
function commentsCut_(html) {
  return html.search(/<section\b[^>]*class="(?:[^"]*\s)?comments(?:\s[^"]*)?"|data-test-id="main-feed-activity-card__comments|class="(?:[^"]*\s)?comment__list(?:\s[^"]*)?"|<ul\b[^>]*class="(?:[^"]*\s)?comments-list(?:\s[^"]*)?"/i);
}

// All elements whose OPENING TAG matches `re`; each returned as [start, end) of the balanced element.
function regions_(html, re) {
  const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
  const out = [];
  let m;
  while ((m = g.exec(html)) !== null) {
    if (m[0].length === 0) { g.lastIndex++; continue; }
    if (inRegions_(out, m.index)) continue;
    const ext = elementExtent_(html, m.index);
    if (ext) out.push(ext);
  }
  return out;
}

// Extent of the element whose opening tag contains offset `idx` (same-name tag balancing). null if idx is
// not inside an opening tag, the tag is void, or the element never closes.
function elementExtent_(html, idx) {
  const start = html.lastIndexOf('<', idx);
  if (start < 0 || html.charAt(start + 1) === '/' || html.charAt(start + 1) === '!') return null;
  const nm = html.slice(start, start + 40).match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
  if (!nm) return null;
  const tag = nm[1].toLowerCase();
  if (/^(?:img|br|hr|meta|link|input|source|area|base|col|embed|param|track|wbr)$/.test(tag)) return null;
  const gt = html.indexOf('>', start);
  if (gt < 0 || gt < idx) return null;
  if (html.charAt(gt - 1) === '/') return [start, gt + 1];
  const re = new RegExp('<(/?)' + tag + '(?=[\\s>/])', 'gi');
  re.lastIndex = gt + 1;
  let depth = 1, m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      depth--;
      if (depth === 0) { const close = html.indexOf('>', m.index); return [start, close < 0 ? html.length : close + 1]; }
    } else {
      const end = html.indexOf('>', m.index);
      if (!(end > 0 && html.charAt(end - 1) === '/')) depth++;
    }
  }
  return null;
}

function inRegions_(list, pos) {
  for (let i = 0; i < list.length; i++) if (pos >= list[i][0] && pos < list[i][1]) return true;
  return false;
}

// ===================== IMAGES =====================
// Banner Image = a genuine static image attached directly to the main post. External link/article previews,
// PDF/document covers, video thumbnails and anything in embedded/reshared/quoted posts are rejected using the
// page structure and media type, not the URL pattern alone. Ambiguous -> empty.
function image_(ld, html, ctx, opts) {
  opts = opts || {};
  const norm = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  const flags = mediaFlags_(ld, html, ctx);
  const dirty = flags.video || flags.article || flags.doc || flags.nested;
  const strict = !!opts.strict || REQUIRE_IMAGE_BLOCK_MARKER;

  const given = {};
  (opts.given || []).forEach(k => { given[k] = true; });
  const poster = posterKeys_(norm, ctx, flags.video);
  const rejected = {};
  const debug = [];
  const seen = {};
  let chosen = '', chosenKey = '';

  // 1) Images found in page markup, judged by where they sit in the page.
  const loose = [];
  const re = new RegExp(IMG_SCAN_RE.source, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = cleanUrl_(m[0]);
    const key = assetKey_(u);
    if (isNonDom_(html, m.index, ctx)) { loose.push(u); continue; }   // <meta>/<link>/<script>/JSON: judged below
    seen[key] = true;
    const v = judgeImg_(html, m.index, u, key, ctx, dirty, strict, given, poster);
    debug.push({ url: u, ok: v.ok, why: v.why });
    if (v.ok) { if (!chosen) { chosen = u; chosenKey = key; } }
    else if (key) rejected[key] = true;
  }

  // 2) Images with no markup context (JSON blobs, og:image, twitter:image, ld+json): usable only when the page
  //    shows no video / article / document / nested media and strict mode is off.
  if (ld) asArray_(ld.image).forEach(i => { loose.push(typeof i === 'string' ? i : (i && (i.url || i.contentUrl))); });
  loose.push(meta_(html, 'og:image'), meta_(html, 'twitter:image'));
  const jr = new RegExp(IMG_SCAN_RE.source, 'gi');
  while ((m = jr.exec(norm)) !== null) loose.push(m[0]);
  loose.forEach(c => {
    const u = c ? cleanUrl_(decode_(String(c))) : '';
    if (!u) return;
    const key = assetKey_(u);
    if (seen[key] && key !== chosenKey) return;          // already judged in context above
    if (dirty) { if (key && key !== chosenKey) rejected[key] = true; return; }  // likely the preview/thumbnail
    if (chosen || strict) return;
    const type = imgType_(u);
    if (!/^feedshare-/i.test(type) || given[key] || poster[key] || rejected[key]) return;
    chosen = u; chosenKey = key;
  });

  Object.keys(poster).forEach(k => { if (k !== chosenKey) rejected[k] = true; });
  if (chosenKey) delete rejected[chosenKey];
  return { url: chosen, rejectKeys: Object.keys(rejected), dirty, debug, flags, posterKeys: Object.keys(poster) };
}

function isNonDom_(html, idx, ctx) {
  if (inRegions_(ctx.nonDom, idx)) return true;
  const start = html.lastIndexOf('<', idx);
  const nm = start >= 0 ? html.slice(start, start + 12).match(/^<([a-zA-Z]+)/) : null;
  return !!nm && /^(?:meta|link)$/i.test(nm[1]);
}

function judgeImg_(html, idx, u, key, ctx, dirty, strict, given, poster) {
  const type = imgType_(u);
  if (!type) return { ok: false, why: 'not a post-image media type' };
  if (given[key]) return { ok: false, why: 'asset rejected on the original page' };
  if (poster[key]) return { ok: false, why: 'video poster / thumbnail asset' };
  if (inRegions_(ctx.nested, idx)) return { ok: false, why: 'inside embedded/reshared/quoted post' };
  if (inRegions_(ctx.comments, idx)) return { ok: false, why: 'inside comments / beyond the main post' };
  if (inRegions_(ctx.video, idx)) return { ok: false, why: 'inside video media' };
  if (inRegions_(ctx.article, idx)) return { ok: false, why: 'inside external article/link preview' };
  if (inRegions_(ctx.doc, idx)) return { ok: false, why: 'inside document/PDF preview' };
  const w = html.slice(Math.max(0, idx - 3000), idx);
  const href = enclosingHref_(w);
  if (href !== null && isExternalHref_(href)) return { ok: false, why: 'wrapped in external link' };
  if (/(?:poster|thumbnail|thumb)[\w-]*=["']$/i.test(w.slice(-30))) return { ok: false, why: 'poster/thumbnail attribute' };
  if (inRegions_(ctx.imageBlocks, idx)) return { ok: true, why: 'inside image attachment block' };
  if (!/^feedshare-/i.test(type)) return { ok: false, why: 'not an uploaded-post image type outside an image block' };
  if (strict) return { ok: false, why: 'not verified: no image-attachment block marker' };
  if (dirty) return { ok: false, why: 'not verified: page also has video/article/document/nested media' };
  return { ok: true, why: 'no other media on page' };
}

// Assets that belong to video media: URLs inside <video> / video blocks, plus (on video pages) URLs given as
// poster / thumbnail / cover / preview properties.
function posterKeys_(norm, ctx, isVideoPage) {
  const keys = {};
  const addFrom = txt => {
    const g = new RegExp(IMG_SCAN_RE.source, 'gi');
    let m;
    while ((m = g.exec(txt)) !== null) { const k = assetKey_(cleanUrl_(decode_(m[0]))); if (k) keys[k] = true; }
  };
  (norm.match(/<video\b[^>]*>/gi) || []).forEach(addFrom);
  if (isVideoPage) {
    const re = /(?:poster|thumbnail|thumb|videoCover|cover|preview)[\w-]*["']?\s*[:=]\s*["']?(https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s<>\\]*)/gi;
    let m;
    while ((m = re.exec(norm)) !== null) { const k = assetKey_(cleanUrl_(decode_(m[1]))); if (k) keys[k] = true; }
  }
  return keys;
}

function mediaFlags_(ld, html, ctx) {
  const text = removeRegions_(html, ctx.comments);
  const ldTxt = ld ? JSON.stringify(ld) : '';
  return {
    nested: ctx.nested.length > 0,
    video: ctx.video.length > 0 || /<video\b|vjs-poster|vjs-big-play-button|play-button|videocover/i.test(text) ||
           /media\.licdn\.com\/dms\/(?:video|vid)\//i.test(text) || /\.mp4\b|\.m3u8\b/i.test(text) ||
           /"(?:videoUrl|playbackUrl|progressiveStreams|adaptiveStreams)"/i.test(text) ||
           /VideoObject/i.test(ldTxt) || !!(ld && ld.video) ||
           /^video/i.test(meta_(html, 'og:type')) || !!meta_(html, 'og:video'),
    article: ctx.article.length > 0,
    doc: ctx.doc.length > 0
  };
}

function removeRegions_(html, list) {
  if (!list.length) return html;
  const sorted = list.slice().sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  sorted.forEach(r => { if (r[0] >= pos) { out += html.slice(pos, r[0]); pos = r[1]; } });
  return out + html.slice(pos);
}

function imgType_(u) {
  const m = String(u).match(IMG_TYPE_RE);
  return (m && !IMG_TYPE_REJECT_RE.test(m[1])) ? m[1] : '';
}

// Stable id of an image asset (ignores size variants and query params).
function assetKey_(u) {
  const p = String(u).split('?')[0].replace(/^https:\/\/media\.licdn\.com\/dms\/image\//i, '').split('/');
  if (p[0] === 'v2') p.shift();
  const k = p.slice(2).join('/');
  return k || p.join('/');
}

function cleanUrl_(s) { return decode_(String(s)).replace(/[,;)]+$/, '').trim(); }

function enclosingHref_(w) {
  const a = lastIdx_(w, /<a[\s>]/i), c = lastIdx_(w, /<\/a>/i);
  if (a < 0 || a < c) return null;
  const end = w.indexOf('>', a);
  const tag = end < 0 ? w.slice(a) : w.slice(a, end + 1);
  const h = tag.match(/\bhref\s*=\s*["']([^"']*)["']/i);
  return h ? decode_(h[1]) : '';
}

function isExternalHref_(h) {
  if (!h) return false;
  const m = h.match(/^(?:https?:)?\/\/([^\/?#]+)([^#]*)/i);
  if (!m) return /^\/?(?:redir\/redirect|safety\/go)/i.test(h);
  if (!/(^|\.)linkedin\.com$/i.test(m[1])) return true;               // includes lnkd.in
  return /^\/(?:redir\/redirect|safety\/go)/i.test(m[2]);
}

function lastIdx_(s, re) {
  const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
  let last = -1, m;
  while ((m = g.exec(s)) !== null) { last = m.index; if (m[0].length === 0) g.lastIndex++; }
  return last;
}

// ===================== HELPERS =====================
function meta_(html, key) {
  for (const tag of (html.match(/<meta\b[^>]*>/gi) || [])) {
    const k = tag.match(/\b(?:property|name)=["']([^"']+)["']/i);
    if (k && k[1].toLowerCase() === key) {
      const c = tag.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i);
      if (c) return decode_(c[1] !== undefined ? c[1] : c[2]);
    }
  }
  return '';
}

function asArray_(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }

function count_(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : null;
  if (v === undefined || v === null) return null;
  const m = String(v).trim().match(/^([\d][\d.,]*)\s*([KkMm])?$/);
  if (!m) return null;
  const n = m[2] ? parseFloat(m[1].replace(',', '.')) * (/k/i.test(m[2]) ? 1e3 : 1e6)
                 : parseInt(m[1].replace(/[.,]/g, ''), 10);
  return isNaN(n) ? null : Math.round(n);
}

function decode_(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, g) => {
    if (g[0] === '#') {
      const code = (g[1] === 'x' || g[1] === 'X') ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (e) { return all; }
    }
    const r = named[g.toLowerCase()];
    return r !== undefined ? r : all;
  });
}

function clean_(s) { return decode_(String(s || '')).replace(/\s+/g, ' ').trim(); }

function text_(s) {
  return decode_(String(s || '')).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
