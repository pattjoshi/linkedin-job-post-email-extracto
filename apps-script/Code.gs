/**
 * Lead Catcher: receives contacts from the Chrome extension and appends them
 * to the first tab of THIS spreadsheet.
 *
 *     A Email | B Recruiter Name | C Company | D Status | Role | Location | Post Link | Added On
 *
 * Columns A to D are your original format and are the only ones your mail script
 * reads. Status is left empty so the mail script treats the row as "not sent yet".
 * Role, Location, Post Link and Added On are added to the right of what is already
 * there, the first time a row is written. Existing rows are never changed.
 *
 * SAME PERSON AGAIN: an email that is already in the sheet gets a NEW row (so it
 * is mailed again) when it comes from a different post and at least `repeatDays`
 * days (3 unless the extension says otherwise) have passed since this script last
 * added that email. The same post is never added twice, and nothing is added while
 * an earlier row for that email still has an empty Status. The date and post of the
 * last add are kept in this project's script properties.
 *
 * HOW TO INSTALL (your sheet already has a mail script, so do NOT delete it):
 *   Extensions > Apps Script > "+" next to Files > Script > name it LeadCatcher
 *   Paste this whole file there, set LC_SECRET below, Save.
 *   Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Every name here starts with LC_ / lc so it cannot clash with your own code.
 * The one exception is doPost: a project can have only one.
 */

// Change this. Put the same value in the extension under "Sheet setup".
const LC_SECRET = 'change-me-to-something-private';

// Memory of the last add per email, kept in script properties as "lc:<email>" = "<time ms>|<post id>".
const LC_LOG_PREFIX = 'lc:';
// Set the first time this version runs. Emails already in the sheet with no memory entry count as added then.
const LC_SEED_KEY = 'lc_seed';
const LC_FORGET_AFTER_DAYS = 90;

// Used only when the first tab is completely empty.
const LC_DEFAULT_HEADERS = ['Email', 'Recruiter Name', 'Company', 'Status'];
// Added to the right of the existing columns when missing.
const LC_EXTRA_HEADERS = ['Role', 'Location', 'Post Link', 'Added On'];
// Header text -> field name used in lcColumnMap_.
const LC_FIELD_OF = { 'Role': 'role', 'Location': 'location', 'Post Link': 'link', 'Added On': 'added', 'Follow-up': 'followup' };

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (LC_SECRET === 'change-me-to-something-private') {
      return lcJson_({ ok: false, error: 'Set LC_SECRET in the script first, then deploy a new version.' });
    }
    if (body.token !== LC_SECRET) return lcJson_({ ok: false, error: 'Wrong secret.' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];
    if (body.ping) return lcJson_({ ok: true, version: 3, sheet: ss.getName() + ' / ' + sheet.getName() });

    // dryRun: say what WOULD happen to each email, and change nothing in the sheet.
    const dry = body.dryRun === true;

    // Header row is created only on an empty tab. An existing header row is only extended to the right.
    if (sheet.getLastRow() === 0) {
      if (dry) return lcJson_({ ok: true, dryRun: true, results: lcDecide_(body, {}, {}, {}, Date.now(), Date.now()).results });
      sheet.appendRow(LC_DEFAULT_HEADERS);
      sheet.getRange(1, 1, 1, LC_DEFAULT_HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    if (!dry) lcEnsureColumns_(sheet, LC_EXTRA_HEADERS);
    const width = sheet.getLastColumn();
    const col = lcColumnMap_(lcHeaders_(sheet, width));
    if (col.email < 0) {
      return lcJson_({ ok: false, error: 'No "Email" column found in row 1 of the first tab.' });
    }

    // Emails already in the sheet. Also find the last used row of the Email column.
    // "waiting" = the email has a row whose Status is still empty, so it has not been mailed yet.
    const seen = {};
    const waiting = {};
    let lastRow = 1;
    const last = sheet.getLastRow();
    if (last > 1) {
      const vals = sheet.getRange(2, 1, last - 1, width).getValues();
      for (let i = 0; i < vals.length; i++) {
        const v = String(vals[i][col.email]).trim().toLowerCase();
        if (!v) continue;
        seen[v] = true;
        lastRow = i + 2;
        if (col.status >= 0 && !String(vals[i][col.status]).trim()) waiting[v] = true;
      }
    }

    // When was each email last added, and from which post?
    const props = PropertiesService.getScriptProperties();
    const memory = props.getProperties();
    const nowMs = Date.now();
    let seed = Number(memory[LC_SEED_KEY]);
    if (!seed) { seed = nowMs; props.setProperty(LC_SEED_KEY, String(seed)); }

    const plan = lcDecide_(body, seen, waiting, memory, seed, nowMs);
    if (dry) return lcJson_({ ok: true, dryRun: true, results: plan.results });

    // Write each field into its own column. Status and any column we do not fill are not touched:
    // neighbouring columns are written together, a gap (such as Status) starts a new block.
    const fields = ['email', 'recruiter', 'company', 'role', 'location', 'link', 'added']
      .filter(function (f) { return col[f] >= 0; })
      .sort(function (a, b) { return col[a] - col[b]; });
    if (plan.rows.length) {
      const when = new Date(nowMs);
      let i = 0;
      while (i < fields.length) {
        let j = i;
        while (j + 1 < fields.length && col[fields[j + 1]] === col[fields[j]] + 1) j++;
        const block = fields.slice(i, j + 1);
        const values = plan.rows.map(function (r) {
          return block.map(function (f) { return f === 'added' ? when : lcSafe_(r[f]); });
        });
        sheet.getRange(lastRow + 1, col[block[0]] + 1, values.length, block.length).setValues(values);
        i = j + 1;
      }
      if (col.added >= 0) sheet.getRange(lastRow + 1, col.added + 1, plan.rows.length, 1).setNumberFormat('d mmm yyyy');
    }
    lcRemember_(props, memory, plan.remember, nowMs);
    return lcJson_({
      ok: true, added: plan.rows.length - plan.repeated, repeated: plan.repeated,
      skipped: plan.skipped, results: plan.results
    });
  } catch (err) {
    return lcJson_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decide what happens to each incoming contact. Changes nothing.
 * status: added (new email), repeat (in sheet, new post, long enough ago: add again),
 *         same_post, waiting (earlier row not mailed yet), too_soon.
 */
function lcDecide_(body, seen, waiting, memory, seed, nowMs) {
  let days = Number(body.repeatDays);
  if (isNaN(days) || days < 0 || body.repeatDays === '' || body.repeatDays == null) days = 3;
  const gapMs = Math.min(days, 365) * 86400000;
  const plan = { rows: [], results: [], remember: {}, skipped: 0, repeated: 0 };
  const inBatch = {};
  (body.rows || []).slice(0, 500).forEach(function (r) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    const key = String(r.key || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80);
    let status = 'added', last = nowMs;
    if (inBatch[email]) status = 'same_post';
    else if (seen[email]) {
      const entry = String(memory[LC_LOG_PREFIX + email] || '').split('|');
      last = Number(entry[0]) || seed;
      if (key && key === entry[1]) status = 'same_post';
      else if (waiting[email]) status = 'waiting';
      else if (nowMs - last < gapMs) status = 'too_soon';
      else status = 'repeat';
    }
    if (status !== 'added' && status !== 'repeat') {
      plan.skipped++;
      plan.results.push({ email: email, status: status, last: last });
      return;
    }
    if (status === 'repeat') plan.repeated++;
    inBatch[email] = true;
    plan.remember[LC_LOG_PREFIX + email] = nowMs + '|' + key;
    plan.results.push({ email: email, status: status, last: status === 'repeat' ? last : nowMs });
    plan.rows.push({
      email: email, recruiter: r.recruiter, company: r.company,
      role: r.role, location: r.location, link: /^https:\/\//.test(String(r.url || '')) ? r.url : ''
    });
  });
  return plan;
}

/** Save the new memory entries and drop a few that are too old to matter. Never fails the request. */
function lcRemember_(props, memory, remember, nowMs) {
  try {
    if (Object.keys(remember).length) props.setProperties(remember);
    const cutoff = nowMs - LC_FORGET_AFTER_DAYS * 86400000;
    let dropped = 0;
    for (const k in memory) {
      if (dropped >= 40) break;
      if (k.indexOf(LC_LOG_PREFIX) === 0 && !remember[k] && Number(String(memory[k]).split('|')[0]) < cutoff) {
        props.deleteProperty(k);
        dropped++;
      }
    }
  } catch (err) {
    console.warn('Lead Catcher memory not saved: ' + err);
  }
}

/** Row 1 as lowercase text. */
function lcHeaders_(sheet, width) {
  return sheet.getRange(1, 1, 1, width).getValues()[0]
    .map(function (v) { return String(v).trim().toLowerCase(); });
}

/** Add the named header cells to the right of the last column when the sheet does not have them yet. */
function lcEnsureColumns_(sheet, names) {
  const width = sheet.getLastColumn();
  const col = lcColumnMap_(lcHeaders_(sheet, width));
  const missing = names.filter(function (n) { return col[LC_FIELD_OF[n]] < 0; });
  if (!missing.length) return;
  const start = width + 1;
  const need = start + missing.length - 1 - sheet.getMaxColumns();
  if (need > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), need);
  sheet.getRange(1, start, 1, missing.length).setValues([missing]);
  // Same look as the existing header cells.
  sheet.getRange(1, 1).copyFormatToRange(sheet, start, start + missing.length - 1, 1, 1);
}

/** Find each column by its header text. -1 = not present. No two fields share a column. */
function lcColumnMap_(headers) {
  const used = {};
  const find = function (words, exact) {
    for (let w = 0; w < words.length; w++) {
      for (let i = 0; i < headers.length; i++) {
        const hit = exact ? headers[i] === words[w] : headers[i].indexOf(words[w]) !== -1;
        if (!used[i] && hit) { used[i] = true; return i; }
      }
    }
    return -1;
  };
  // Order matters: Email and Company are claimed first, so "Company Name" is never taken as the recruiter.
  const email = find(['email', 'e-mail', 'mail']);
  const company = find(['company', 'organisation', 'organization', 'firm']);
  const recruiter = find(['recruiter', 'recruter', 'recreter', 'hr name', 'contact', 'name']);
  const status = find(['status'], true);
  const followup = find(['follow-up', 'follow up', 'followup']);
  const role = find(['role', 'position', 'designation', 'job title']);
  const location = find(['location', 'city']);
  const link = find(['post link', 'link', 'url']);
  const added = find(['added on', 'added', 'date']);
  return {
    email: email, company: company, recruiter: recruiter, status: status, followup: followup,
    role: role, location: location, link: link, added: added
  };
}

/** Stop a cell value from being run as a formula. */
function lcSafe_(v) {
  const s = String(v == null ? '' : v).slice(0, 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function lcJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
