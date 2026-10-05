/*
 * Runs on linkedin.com. Reads only what is already on the page you have open:
 * it never navigates, never calls LinkedIn's APIs and never scrolls for you.
 * The side panel asks it to scan; it answers with the posts that contain an email.
 */
(() => {
  if (window.__leadCatcherLoaded) return;
  window.__leadCatcherLoaded = true;

  const X = globalThis.LeadExtract;

  // Known post wrappers. LinkedIn renames classes often, so there is also a
  // selector-free fallback below (findContainer).
  const POST_SEL = [
    'div.feed-shared-update-v2',
    '[data-urn^="urn:li:activity"]',
    '[data-id^="urn:li:activity"]',
    '[data-urn^="urn:li:share"]',
    '[data-urn^="urn:li:ugcPost"]',
    '[data-view-name="feed-full-update"]',
    'div[role="article"]',
    'article'
  ].join(',');
  const AUTHOR_SEL = 'a[href*="/in/"], a[href*="/company/"]';
  const COMMENT_CLASS = /(^|[\s_])comments?-[a-z]/i;
  const HAS_EMAIL = /@[A-Za-z0-9-]+\.[A-Za-z]|[\[({]\s*at\s*[\])}]/i;
  const NOISE_LINE = /^([•·]\s*)?(1st|2nd|3rd\+?|following|follow|verified|premium|promoted|edited|feed post|suggested|he\/him|she\/her|they\/them|\d+\s?(s|m|h|d|w|mo|yr)\b.*|\d+\s(second|minute|hour|day|week|month|year)s?\sago.*|visible to .*)$/i;
  const SOCIAL_LINE = /\b(likes?|loves?|reposted|commented on|celebrates?|supports?|finds?|reacted to|follows?)\s+(this|on this)\b/i;

  // Posts already read, with the size of their text at that time. While "Keep scanning" is on,
  // a post is read again only if its text changed (for example after "see more" opened).
  let seen = new WeakMap();
  const sizeOf = el => (el.textContent || '').length;
  const isSeen = el => seen.has(el) && seen.get(el) === sizeOf(el);
  function insideSeen(el) {
    for (; el && el !== document.body; el = el.parentElement) if (isSeen(el)) return true;
    return false;
  }

  function isCommentEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (COMMENT_CLASS.test(cls)) return true;
    const view = el.getAttribute('data-view-name') || '';
    return /comment/i.test(view) && !/commentary/i.test(view);
  }

  function insideComment(node, stopAt) {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el && el !== stopAt; el = el.parentElement) {
      if (isCommentEl(el)) return true;
    }
    return false;
  }

  // Open the "...see more" fold inside posts so the email is in the page text.
  function expandFolds(onlyNew) {
    let n = 0;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (n >= 40) break;
      const t = (b.textContent || '').trim();          // textContent: no layout work, unlike innerText
      if (t.length > 14 || !/^(…|\.\.\.)\s*(see\s+)?more$|^see more$/i.test(t)) continue;
      if (onlyNew && insideSeen(b)) continue;
      if (insideComment(b, document.body)) continue;
      try { b.click(); n++; } catch (_) { /* ignore */ }
    }
    return n;
  }

  function findContainer(textNode) {
    const start = textNode.parentElement;
    if (!start) return null;
    const known = start.closest(POST_SEL);
    if (known) {
      // Prefer the outermost known wrapper that is still a single post.
      let best = known;
      for (let p = known.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.matches(POST_SEL) && (p.innerText || '').length < 8000) best = p;
      }
      return best;
    }
    // Fallback: climb until the block has an avatar and a profile/company link (a post header).
    let best = null;
    for (let el = start; el && el !== document.body; el = el.parentElement) {
      const len = (el.innerText || '').length;
      if (len > 8000) break;
      if (len >= 80 && el.querySelector('img') && el.querySelector(AUTHOR_SEL)) { best = el; break; }
    }
    return best;
  }

  function postText(container) {
    let text = container.innerText || '';
    const roots = [];
    for (const el of container.querySelectorAll('*')) {
      if (isCommentEl(el) && !roots.some(r => r.contains(el))) roots.push(el);
    }
    for (const r of roots) {
      const t = r.innerText || '';
      if (t.length > 3) text = text.split(t).join('\n');
    }
    return text;
  }

  function readAuthor(container, lines) {
    for (const a of container.querySelectorAll(AUTHOR_SEL)) {
      if (insideComment(a, container)) continue;
      const img = a.querySelector('img[alt]');
      const name = X.cleanName(a.innerText) || X.cleanName(a.getAttribute('aria-label')) ||
        X.cleanName(img && img.getAttribute('alt'));
      if (!name || name.length < 2 || name.length > 70 || !/\p{L}/u.test(name)) continue;
      const idx = lines.findIndex(l => l.includes(name));
      if (idx >= 0 && SOCIAL_LINE.test(lines[idx])) continue; // "Asha likes this" banner, not the author
      let headline = '';
      if (idx >= 0) {
        for (const l of lines.slice(idx + 1, idx + 6)) {
          if (l === name || l.startsWith(name) || NOISE_LINE.test(l) || l.length < 4) continue;
          headline = l.slice(0, 160);
          break;
        }
      }
      return { name, headline, isCompany: /\/company\//.test(a.getAttribute('href') || '') };
    }
    return { name: '', headline: '', isCompany: false };
  }

  function postUrl(container) {
    const holder = container.closest('[data-urn], [data-id]') || container.querySelector('[data-urn], [data-id]');
    const urn = holder && (holder.getAttribute('data-urn') || holder.getAttribute('data-id')) || '';
    if (/^urn:li:(activity|share|ugcPost):\d+/.test(urn)) {
      return 'https://www.linkedin.com/feed/update/' + urn.match(/^urn:li:[A-Za-z]+:\d+/)[0] + '/';
    }
    const link = container.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
    if (link) return link.href.split('?')[0];
    return location.href;
  }

  function scan(opts) {
    // onlyNew: skip every post that was already read and has not changed. A normal scan reads everything.
    const onlyNew = !!(opts && opts.onlyNew);
    if (!onlyNew) seen = new WeakMap();
    const expanded = opts && opts.expand === false ? 0 : expandFolds(onlyNew);
    const containers = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
        return onlyNew && isSeen(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;   // REJECT skips the whole post
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (!HAS_EMAIL.test(node.nodeValue)) continue;
      if (insideComment(node, document.body)) continue;
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'TEXTAREA') continue;
      const c = findContainer(node);
      if (c) containers.add(c);
    }
    // Drop wrappers that merely contain another matched post.
    const list = [...containers].filter(c => ![...containers].some(o => o !== c && c.contains(o)));

    const posts = [];
    for (const c of list) {
      const text = postText(c);
      const emails = X.findEmails(text);
      if (!emails.length) continue;
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      const author = readAuthor(c, lines);
      posts.push({
        emails,
        author: author.isCompany ? '' : author.name,
        authorCompany: author.isCompany ? author.name : '',
        headline: author.headline,
        url: postUrl(c),
        text: text.replace(/\n{2,}/g, '\n').slice(0, 2500)
      });
    }
    // Remember every post on the page, with or without an email, so the next quiet scan can skip it.
    for (const el of document.querySelectorAll(POST_SEL)) seen.set(el, sizeOf(el));
    for (const c of list) seen.set(c, sizeOf(c));
    return { ok: true, page: location.href, expanded, posts, onlyNew };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'LC_SCAN') return;
    try { sendResponse(scan(msg)); }
    catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }); }
  });
})();
