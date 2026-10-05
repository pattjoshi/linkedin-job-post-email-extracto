import * as pdfjs from './lib/pdf.min.mjs';
import { unzipSync, strFromU8 } from './lib/fflate.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const X = globalThis.LeadExtract;
const $ = id => document.getElementById(id);

const state = {
  keywords: [],
  resumeName: '',
  leads: {},                       // keyed by email
  ideasRun: { day: '', queries: [] }, // search lines already run today
  settings: {
    url: '', token: '', onlyMatch: true, city: '', when: 'day',
    years: '', locations: '', repeatDays: '3', exclude: 'c2c, corp to corp, w2, 1099, us citizen, green card, h1b, unpaid', blocked: '', showHidden: false
  }
};

// ---------- storage ----------

async function load() {
  const saved = await chrome.storage.local.get(['keywords', 'resumeName', 'leads', 'settings', 'ideasRun']);
  state.keywords = saved.keywords || [];
  state.resumeName = saved.resumeName || '';
  state.leads = saved.leads || {};
  state.settings = Object.assign(state.settings, saved.settings || {});
  state.ideasRun = saved.ideasRun || { day: '', queries: [] };
  if (prune()) save();
}

// Keep storage small: forget contacts sent more than 45 days ago and unsent ones older than 30 days.
// The sheet still has every row, and the sheet script still decides whether someone can be added again.
function prune() {
  const now = Date.now();
  let dropped = 0;
  for (const [email, l] of Object.entries(state.leads)) {
    const age = (now - (l.sent ? (l.lastSentAt || l.foundAt || 0) : (l.foundAt || 0))) / 86400000;
    if (age > (l.sent ? 45 : 30)) { delete state.leads[email]; dropped++; }
  }
  return dropped;
}
const save = () => chrome.storage.local.set({
  keywords: state.keywords, resumeName: state.resumeName, leads: state.leads, settings: state.settings,
  ideasRun: state.ideasRun
});

// ---------- tiny DOM helper ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
function say(id, text, isError) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

// ---------- resume ----------

async function readPdf(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return text;
}

function readDocx(buf) {
  const files = unzipSync(new Uint8Array(buf), { filter: f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f.name) });
  let text = '';
  for (const name of Object.keys(files)) {
    text += strFromU8(files[name])
      .replace(/<\/w:p>/g, '\n').replace(/<w:(tab|br)\b[^>]*\/>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") + '\n';
  }
  return text;
}

async function handleResume(file) {
  if (!file) return;
  say('dropText', 'Reading ' + file.name + '…');
  try {
    const name = file.name.toLowerCase();
    let text;
    if (name.endsWith('.pdf') || file.type === 'application/pdf') text = await readPdf(await file.arrayBuffer());
    else if (name.endsWith('.docx')) text = readDocx(await file.arrayBuffer());
    else if (name.endsWith('.doc')) throw new Error('Old .doc files are not supported. Save it as PDF or DOCX.');
    else text = await file.text();

    if (text.replace(/\s/g, '').length < 40) {
      throw new Error('No text found. If the PDF is a scanned image, upload a DOCX or text version.');
    }
    // Job titles written in the resume go first: they drive the search ideas.
    const titles = X.extractTitles(text, 3);
    const found = titles.concat(X.extractKeywords(text, 30).filter(k => !titles.includes(k))).slice(0, 30);
    if (!found.length) throw new Error('Could not pick out skills. Add a few below by hand.');
    state.keywords = found;
    state.resumeName = file.name;
    // Fill "Your experience" from the resume if it says so and the field is still empty.
    const years = X.guessYears(text);
    if (years != null && state.settings.years === '') state.settings.years = String(years);
    rematchAll();
    await save();
    render();
  } catch (err) {
    $('dropText').textContent = 'Upload resume (PDF, DOCX or TXT)';
    say('scanMsg', err.message || String(err), true);
  }
}

function rematchAll() {
  for (const lead of Object.values(state.leads)) lead.matched = X.matchKeywords(lead.text, state.keywords);
}

// ---------- search ideas ----------

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// Runs the search in your LinkedIn tab (or a new tab). You pressed the button; nothing is automatic.
async function openSearch(query) {
  const url = X.searchUrl(query, state.settings.when);
  try {
    const tab = await linkedInTab();
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } else {
      await chrome.tabs.create({ url });
    }
    const day = new Date().toDateString();
    if (state.ideasRun.day !== day) state.ideasRun = { day, queries: [] };
    if (!state.ideasRun.queries.includes(query)) state.ideasRun.queries.push(query);
    save();
    renderIdeas();
    say('ideaMsg', 'Searching. When the posts have loaded, press “Scan this page”.');
  } catch (err) {
    say('ideaMsg', err.message || String(err), true);
  }
}

const ranToday = query => state.ideasRun.day === new Date().toDateString() && state.ideasRun.queries.includes(query);

function ideaRow(idea) {
  return h('div', { class: 'idea' + (ranToday(idea.query) ? ' ran' : '') },
    h('code', {}, idea.query, ranToday(idea.query) ? h('span', { class: 'tag' }, 'searched today') : null),
    h('div', { class: 'why' }, idea.why),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => openSearch(idea.query) }, 'Search'),
      h('button', {
        type: 'button', class: 'ghost',
        onclick: async e => {
          const ok = await copyText(idea.query);
          e.target.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        }
      }, 'Copy')));
}

let showAllIdeas = false;
function renderIdeas() {
  const ideas = X.suggestSearches(state.keywords, { location: state.settings.city });
  if (!ideas.length) {
    $('ideas').replaceChildren(h('div', { class: 'empty' }, 'Upload your resume to get search ideas.'));
    return;
  }
  const shown = showAllIdeas ? ideas : ideas.slice(0, 4);
  const more = ideas.length - shown.length;
  // One button that walks through the list: it runs the first search you have not run today.
  const nextUp = ideas.find(i => !ranToday(i.query));
  const done = ideas.length - ideas.filter(i => !ranToday(i.query)).length;
  $('ideas').replaceChildren(
    h('div', { class: 'row' },
      h('button', { type: 'button', disabled: !nextUp, onclick: () => nextUp && openSearch(nextUp.query) },
        nextUp ? 'Run next search' : 'All searches done today'),
      h('span', { class: 'hint' }, `${done} of ${ideas.length} run today`)),
    ...shown.map(ideaRow),
    ideas.length > 4 ? h('button', {
      type: 'button', class: 'ghost',
      onclick: () => { showAllIdeas = !showAllIdeas; renderIdeas(); }
    }, showAllIdeas ? 'Show fewer' : `Show ${more} more`) : null);
}

// ---------- scanning ----------

const DAY = 86400000;
function gapDays() {
  const n = parseFloat(state.settings.repeatDays);
  return isNaN(n) || n < 0 ? 3 : n;
}
const keyOf = lead => lead.key || X.postKey(lead.url, lead.text);
const daysAgo = ms => Math.max(0, Math.floor((Date.now() - ms) / DAY));

async function linkedInTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (!tabs.length) return null;
  // Prefer the LinkedIn tab you are looking at, then the one used most recently.
  return tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
}

async function askPage(tabId, expand, onlyNew) {
  const msg = { type: 'LC_SCAN', expand, onlyNew };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    // Tab was open before the extension was installed: inject the reader, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/extract.js', 'content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

let scanning = false;
async function scan(quiet) {
  if (scanning) return;
  scanning = true;
  $('scanBtn').disabled = true;
  try {
    const tab = await linkedInTab();
    if (!tab) { say('scanMsg', 'No LinkedIn tab is open in this browser.', true); return; }
    // "Keep scanning while I scroll" (quiet) reads only posts that are new since the last scan.
    const res = await askPage(tab.id, true, !!quiet);
    if (!res || !res.ok) throw new Error(res && res.error || 'The page did not answer. Reload the LinkedIn tab and try again.');

    let added = 0, again = 0, emails = 0;
    for (const post of res.posts) {
      const key = X.postKey(post.url, post.text);
      for (const email of post.emails) {
        emails++;
        const old = state.leads[email];
        if (old) {
          // Same person again. Offer them again only for a different post, and only after the gap.
          const last = old.lastSentAt || old.foundAt || 0;
          const done = old.sentKeys || [keyOf(old)];
          if (!old.sent || done.includes(key) || Date.now() - last < gapDays() * DAY) continue;
          Object.assign(old, {
            headline: post.headline || old.headline, url: post.url, text: post.text, key,
            matched: X.matchKeywords(post.text, state.keywords), hiring: X.looksLikeHiring(post.text),
            foundAt: Date.now(), selected: true, override: false, sent: false,
            repeat: true, lastSentAt: last, sentKeys: done
          });
          again++;
          continue;
        }
        state.leads[email] = {
          email,
          key,
          recruiter: post.author || '',
          company: X.guessCompany(post.headline, post.text, email) || post.authorCompany || '',
          headline: post.headline || '',
          url: post.url,
          text: post.text,
          matched: X.matchKeywords(post.text, state.keywords),
          hiring: X.looksLikeHiring(post.text),
          foundAt: Date.now(),
          selected: true,
          sent: false
        };
        added++;
      }
    }
    if (added || again) { await save(); render(); queueCheck(); }
    if (!quiet || added || again) {
      say('scanMsg', emails
        ? `${res.posts.length} post(s) with an email on this page, ${added} new contact(s) added` +
          (again ? `, ${again} earlier contact(s) back with a new post.` : '.')
        : 'No emails in the posts loaded on this page yet. Scroll to load more posts, then scan again.');
    }
  } catch (err) {
    say('scanMsg', err.message || String(err), true);
  } finally {
    scanning = false;
    $('scanBtn').disabled = false;
  }
}

let autoTimer = null;
function setAuto(on) {
  clearInterval(autoTimer);
  autoTimer = on ? setInterval(() => scan(true), 3000) : null;
}

// ---------- list ----------

// Fit of every contact against the "Fit filter" settings. Rebuilt on each render, never stored.
let fits = new Map();
const fitCache = new Map();     // email -> { sig, fit }
const fitOf = lead => fits.get(lead.email) || { score: 0, blocked: null, notes: [] };

function refit() {
  const st = state.settings;
  const squash = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefs = {
    years: st.years === '' ? null : parseFloat(st.years),
    locations: X.splitList(st.locations),
    exclude: X.splitList(st.exclude),
    blocked: X.splitList(st.blocked),
    mailed: new Set(Object.values(state.leads).filter(l => l.sent && l.company).map(l => squash(l.company)))
  };
  // Re-score a contact only when it, or a setting that affects it, changed.
  const prefSig = [st.years, st.locations, st.exclude, st.blocked].join('|');
  const next = new Map();
  for (const l of Object.values(state.leads)) {
    const sig = [prefSig, keyOf(l), l.company, l.headline, (l.matched || []).join(','), l.sent, l.hiring,
      prefs.mailed.has(squash(l.company))].join('|');
    const old = fitCache.get(l.email);
    const fit = old && old.sig === sig ? old.fit : X.assessFit(l, prefs);
    fitCache.set(l.email, { sig, fit });
    next.set(l.email, fit);
  }
  for (const email of fitCache.keys()) if (!next.has(email)) fitCache.delete(email);
  fits = next;
}

// A contact that failed a rule is only sent if you tick it yourself.
const isChosen = lead => (fitOf(lead).blocked ? !!lead.override : !!lead.selected) && !lead.sent && !sheetSkips(lead);

function matchingLeads() {
  const all = Object.values(state.leads);
  if (!state.settings.onlyMatch || !state.keywords.length) return all;
  return all.filter(l => l.matched && l.matched.length);
}

// Best fit first, then contacts that failed a rule (only when "show hidden" is ticked), then ones already sent.
const rank = lead => lead.sent ? 2 : (fitOf(lead).blocked || sheetSkips(lead)) ? 1 : 0;
function visibleLeads() {
  return matchingLeads()
    .filter(l => state.settings.showHidden || !fitOf(l).blocked || l.sent)
    .sort((a, b) => (rank(a) - rank(b)) || (fitOf(b).score - fitOf(a).score) || (b.foundAt - a.foundAt));
}

function leadRow(lead) {
  const edit = (field, placeholder) => h('input', {
    type: 'text', value: lead[field] || '', placeholder, 'aria-label': placeholder,
    onchange: e => { lead[field] = e.target.value.trim(); save(); }
  });
  const fit = fitOf(lead);
  const off = fit.blocked && !lead.sent;
  const skip = sheetSkips(lead);
  const who = X.companyType(lead);
  return h('div', { class: 'lead' + (lead.sent ? ' sent' : '') + (off || skip ? ' off' : '') },
    h('input', {
      type: 'checkbox', checked: isChosen(lead), disabled: lead.sent || skip,
      'aria-label': 'Include ' + lead.email,
      onchange: e => {
        if (fit.blocked) lead.override = e.target.checked; else lead.selected = e.target.checked;
        save(); updateCount();
      }
    }),
    h('div', { class: 'email' }, lead.email,
      h('span', { class: 'score', title: 'Fit score out of 100: skills, job title, experience, location' }, String(fit.score))),
    off ? h('div', { class: 'why-off' }, 'Fit filter: ' + fit.blocked) : null,
    h('div', { class: 'fields' }, edit('recruiter', 'Recruiter name'), edit('company', 'Company name')),
    h('div', { class: 'meta' },
      sheetTag(lead),
      who.kind === 'consultancy' ? h('span', { class: 'tag info', title: 'Agency wording in the post, or an agency-style company name or email' }, 'consultancy') : null,
      who.kind === 'company' ? h('span', { class: 'tag good', title: 'Company email address and no agency wording' }, 'company email') : null,
      who.personal ? h('span', { class: 'tag info', title: 'Gmail, Yahoo, Outlook or similar' }, 'personal email') : null,
      lead.repeat && !lead.sent && !sheetState(lead)
        ? h('span', { class: 'tag good', title: 'You sent this person before. This is a different post, so they will be added again.' },
          'new post, last sent ' + daysAgo(lead.lastSentAt || lead.foundAt) + ' day(s) ago')
        : null,
      lead.sent && lead.lastStatus === 'too_soon'
        ? h('span', { class: 'tag info' }, 'not added again: sent ' + daysAgo(lead.lastSentAt) + ' day(s) ago')
        : null,
      fit.notes.map(n => h('span', { class: 'tag ' + n.kind }, n.text)),
      (lead.matched || []).slice(0, 6).map(k => h('span', { class: 'chip plain' }, k)),
      lead.sent ? h('span', { class: 'tag' }, 'in sheet') : null,
      !lead.hiring ? h('span', { class: 'tag', title: 'The post has no clear hiring wording' }, 'check post') : null,
      h('a', { href: lead.url, target: '_blank', rel: 'noreferrer' }, 'Open post')
    )
  );
}

function updateCount() {
  const list = visibleLeads();
  const ready = list.filter(isChosen).length;
  $('count').textContent = list.length ? `(${list.length})` : '';
  $('sendBtn').textContent = ready ? `Send ${ready} to Google Sheet` : 'Send to Google Sheet';
  $('sendBtn').disabled = !ready;
  $('csvBtn').disabled = !list.length;
}

function render() {
  $('dropText').textContent = state.resumeName ? state.resumeName + ' (click to replace)' : 'Upload resume (PDF, DOCX or TXT)';
  $('chips').replaceChildren(...state.keywords.map(k => h('span', { class: 'chip' }, k,
    h('button', {
      type: 'button', 'aria-label': 'Remove ' + k,
      onclick: () => { state.keywords = state.keywords.filter(x => x !== k); rematchAll(); save(); render(); }
    }, '×'))));

  $('cityInput').value = state.settings.city || '';
  $('dateSelect').value = state.settings.when || 'day';
  renderIdeas();

  const st = state.settings;
  $('expYears').value = st.years;
  $('locInput').value = st.locations;
  $('excludeInput').value = st.exclude;
  $('blockInput').value = st.blocked;
  $('repeatDays').value = st.repeatDays;
  const rules = [st.years !== '' && st.years + ' yrs', st.locations && 'places', st.exclude && 'skip words', st.blocked && 'blocked companies'].filter(Boolean);
  $('fitSummary').textContent = rules.length ? rules.join(' · ') : 'not set';

  refit();
  const list = visibleLeads();
  const total = Object.keys(state.leads).length;
  const hidden = matchingLeads().filter(l => fitOf(l).blocked && !l.sent).length;
  $('showHiddenRow').hidden = !hidden;
  $('showHidden').checked = !!st.showHidden;
  $('showHiddenText').textContent = `Show ${hidden} hidden by the fit filter`;
  const box = $('leads');
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' }, hidden
      ? `All ${hidden} matching contact(s) were hidden by the fit filter. Tick “Show hidden” to review them.`
      : total
        ? `${total} contact(s) found, none match your resume keywords. Untick “Only matching my resume” to see them.`
        : 'Nothing yet. Scan a LinkedIn page that shows hiring posts.'));
  } else {
    box.replaceChildren(...list.map(leadRow));
  }
  $('onlyMatch').checked = !!state.settings.onlyMatch;
  $('sheetUrl').value = state.settings.url || '';
  $('sheetToken').value = state.settings.token || '';
  updateCount();
}

// ---------- output ----------

const toRow = l => ({
  email: l.email, company: l.company || '', recruiter: l.recruiter || '',
  role: X.guessRole(l.text, state.keywords), location: X.placeLabel(l.text),
  matched: (l.matched || []).join(', '), url: /\/(feed\/update|posts)\//.test(l.url || '') ? l.url : '', key: keyOf(l)
});

// ---------- "already in sheet" check ----------

// What the sheet would do with a contact, asked before you press Send. Trusted for 12 hours.
const SHEET_SKIP = { too_soon: 1, waiting: 1, same_post: 1 };
function sheetState(lead) {
  const s = lead.sheet;
  return s && !lead.sent && Date.now() - s.at < 12 * 3600000 ? s : null;
}
const sheetSkips = lead => { const s = sheetState(lead); return !!(s && SHEET_SKIP[s.status]); };

function sheetTag(lead) {
  const s = sheetState(lead);
  if (!s || s.status === 'added') return null;
  const ago = daysAgo(s.last);
  const left = Math.max(1, Math.ceil(gapDays() - (Date.now() - s.last) / DAY));
  const text = {
    repeat: `in sheet ${ago} day(s) ago, will be added again`,
    too_soon: `in sheet: added ${ago} day(s) ago, wait ${left} more day(s)`,
    waiting: 'in sheet, not mailed yet',
    same_post: 'this post is already in the sheet'
  }[s.status];
  return text ? h('span', { class: 'tag ' + (s.status === 'repeat' ? 'good' : 'info') }, text) : null;
}

let checking = false, checkTimer = null;
async function checkSheet() {
  const url = (state.settings.url || '').trim();
  const leads = Object.values(state.leads).filter(l => !l.sent).slice(0, 500);
  if (checking || !url || !leads.length) return;
  checking = true;
  try {
    const data = await callSheet({ rows: leads.map(toRow), dryRun: true, repeatDays: gapDays() });
    if (!data.dryRun || !data.results) return;          // old sheet script: it has no check
    const answer = new Map(data.results.map(r => [r.email, r]));
    const at = Date.now();
    for (const l of leads) {
      const r = answer.get(l.email);
      l.sheet = r ? { status: r.status, last: r.last, at } : null;
    }
    await save();
    render();
  } catch (_) {
    // Not connected or offline: the list simply shows no sheet tags. Send still reports what happened.
  } finally {
    checking = false;
  }
}
const queueCheck = () => { clearTimeout(checkTimer); checkTimer = setTimeout(checkSheet, 1500); };

async function callSheet(payload) {
  const url = (state.settings.url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) {
    throw new Error('Add your web app URL under “Sheet setup” first (it ends in /exec).');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight Apps Script cannot answer
    body: JSON.stringify(Object.assign({ token: state.settings.token || '' }, payload)),
    redirect: 'follow'
  });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); }
  catch (_) { throw new Error('The sheet script did not return JSON. Re-deploy it with access set to “Anyone”.'); }
  if (!data.ok) throw new Error(data.error || 'The sheet script reported an error.');
  return data;
}

async function sendToSheet() {
  const leads = visibleLeads().filter(isChosen);
  if (!leads.length) return;
  $('sendBtn').disabled = true;
  say('sendMsg', 'Sending…');
  try {
    const data = await callSheet({ rows: leads.map(toRow), repeatDays: gapDays() });
    // The sheet script says what it did with each email: added, repeat, same_post, too_soon or waiting.
    const answer = new Map((data.results || []).map(r => [r.email, r]));
    const count = { added: 0, repeat: 0, same_post: 0, too_soon: 0, waiting: 0 };
    const now = Date.now();
    for (const l of leads) {
      const r = answer.get(l.email) || { status: data.results ? 'same_post' : 'added', last: now };
      count[r.status] = (count[r.status] || 0) + 1;
      const wrote = r.status === 'added' || r.status === 'repeat';
      l.key = keyOf(l);                       // keep the post id before the text is shortened
      l.sent = true;
      l.repeat = false;
      l.sheet = null;
      l.text = String(l.text || '').slice(0, 400);   // a sent contact no longer needs the full post
      l.lastStatus = r.status;
      l.lastSentAt = wrote ? now : (r.last || now);
      // A post skipped as "too soon" is not marked done, so it is offered again once the gap has passed.
      l.sentKeys = (l.sentKeys || []).concat(r.status === 'too_soon' ? [] : [keyOf(l)]).slice(-10);
    }
    await save();
    render();
    const parts = [`${count.added} new row(s) added`];
    if (count.repeat) parts.push(`${count.repeat} added again for a new post`);
    if (count.too_soon) parts.push(`${count.too_soon} skipped (sent less than ${gapDays()} day(s) ago)`);
    if (count.waiting) parts.push(`${count.waiting} skipped (already in the sheet, not mailed yet)`);
    if (count.same_post) parts.push(`${count.same_post} skipped (same post already in the sheet)`);
    say('sendMsg', parts.join(', ') + '.' +
      (data.results ? '' : ' Your sheet script is the old version: update LeadCatcher.gs to mail the same person again.'));
  } catch (err) {
    say('sendMsg', err.message || String(err), true);
    updateCount();
  }
}

function downloadCsv() {
  const q = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  // Same column order as the Google Sheet, extras after.
  const rows = [['Email', 'Recruiter Name', 'Company', 'Status', 'Role', 'Location', 'Post Link', 'Matched Skills']]
    .concat(visibleLeads().map(l => { const r = toRow(l); return [r.email, r.recruiter, r.company, '', r.role, r.location, r.url, r.matched]; }));
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'linkedin-contacts.csv' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- wiring ----------

$('resumeFile').addEventListener('change', e => handleResume(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleResume(e.dataTransfer.files[0]); });

$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const added = $('addInput').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const k of added) if (!state.keywords.includes(k)) state.keywords.push(k);
  $('addInput').value = '';
  rematchAll(); save(); render();
});

$('cityInput').addEventListener('input', e => { state.settings.city = e.target.value.trim(); save(); renderIdeas(); });
$('dateSelect').addEventListener('change', e => { state.settings.when = e.target.value; save(); });

// Fit filter fields: save on change, then re-check every contact.
for (const [id, key] of [['expYears', 'years'], ['locInput', 'locations'], ['excludeInput', 'exclude'], ['blockInput', 'blocked'], ['repeatDays', 'repeatDays']]) {
  $(id).addEventListener('change', e => {
    state.settings[key] = e.target.value.trim(); save(); render();
    if (key === 'repeatDays') queueCheck();
  });
}
$('showHidden').addEventListener('change', e => { state.settings.showHidden = e.target.checked; save(); render(); });

$('scanBtn').addEventListener('click', () => scan(false));
$('autoScan').addEventListener('change', e => setAuto(e.target.checked));
$('onlyMatch').addEventListener('change', e => { state.settings.onlyMatch = e.target.checked; save(); render(); });
$('sendBtn').addEventListener('click', sendToSheet);
$('csvBtn').addEventListener('click', downloadCsv);
$('clearBtn').addEventListener('click', () => {
  const n = Object.keys(state.leads).length;
  if (!n) return;
  if ($('clearBtn').dataset.armed) {
    state.leads = {}; delete $('clearBtn').dataset.armed; $('clearBtn').textContent = 'Clear';
    save(); render(); say('sendMsg', 'List cleared. Rows already in your sheet are untouched.');
  } else {
    $('clearBtn').dataset.armed = '1';
    $('clearBtn').textContent = `Click again to clear ${n}`;
    setTimeout(() => { delete $('clearBtn').dataset.armed; $('clearBtn').textContent = 'Clear'; }, 4000);
  }
});

$('settingsBtn').addEventListener('click', () => {
  const box = $('settings');
  box.hidden = !box.hidden;
  $('settingsBtn').setAttribute('aria-expanded', String(!box.hidden));
});
function readSettings() {
  state.settings.url = $('sheetUrl').value.trim();
  state.settings.token = $('sheetToken').value.trim();
  return save();
}
$('saveSettings').addEventListener('click', async () => { await readSettings(); say('settingsMsg', 'Saved.'); });
$('testSheet').addEventListener('click', async () => {
  await readSettings();
  say('settingsMsg', 'Testing…');
  try {
    const data = await callSheet({ ping: true });
    say('settingsMsg', `Connected to “${data.sheet}”.` +
      (data.version >= 3 ? '' : ' The sheet script is an older version: update LeadCatcher.gs for job details and the “already in sheet” check.'));
    queueCheck();
  } catch (err) { say('settingsMsg', err.message || String(err), true); }
});

await load();
render();
queueCheck();
if (!state.settings.url) say('sendMsg', 'Sheet not connected yet. Open “Sheet setup”, or use Download CSV.');
