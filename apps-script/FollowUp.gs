/**
 * Lead Catcher follow-ups. A separate file: it never calls or changes Code.gs.
 * It needs LeadCatcher.gs in the same project (it uses its column helpers).
 *
 * HOW TO USE
 *   1. In the editor's function list (next to Run and Debug) choose previewFollowUps, press Run.
 *      It sends nothing and changes nothing. Read the list under "Execution log".
 *   2. When the list looks right, choose sendFollowUps and press Run.
 *
 * WHO GETS A FOLLOW-UP
 *   A row whose Status contains "Sent" and whose "Follow-up" cell is empty, when your last
 *   mail to that address (found in Gmail's Sent) is between FU_AFTER_DAYS and FU_MAX_AGE_DAYS
 *   days old and nobody has replied in that conversation. Each address gets one follow-up
 *   per mail you sent: the result is written in the "Follow-up" column, added to the right
 *   of your sheet on the first sendFollowUps run. Columns A to D are never written.
 */

const FU_AFTER_DAYS = 5;      // wait this many days after your mail
const FU_MAX_AGE_DAYS = 30;   // older mails are marked "too old" and left alone
const FU_MAX_PER_RUN = 20;    // at most this many follow-ups each time you press Run
const FU_HEADER = 'Follow-up';

/** Shows who would get a follow-up. Sends nothing, writes nothing. */
function previewFollowUps() { fuRun_(false); }

/** Sends the follow-ups and records them in the "Follow-up" column. */
function sendFollowUps() { fuRun_(true); }

function fuRun_(send) {
  const started = Date.now();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const last = sheet.getLastRow();
  if (last < 2) { console.log('The sheet has no rows yet.'); return; }
  if (send) lcEnsureColumns_(sheet, [FU_HEADER]);
  const width = sheet.getLastColumn();
  const col = lcColumnMap_(lcHeaders_(sheet, width));
  if (col.email < 0 || col.status < 0) { console.log('Email or Status column not found in row 1.'); return; }
  const data = sheet.getRange(2, 1, last - 1, width).getValues();
  const tz = Session.getScriptTimeZone();

  // All rows of each address, top to bottom.
  const rowsOf = {};
  data.forEach(function (r, i) {
    const email = String(r[col.email]).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) (rowsOf[email] = rowsOf[email] || []).push(i);
  });

  const log = [];
  const count = { sent: 0, replied: 0, bounced: 0, early: 0, old: 0, unknown: 0 };
  const emails = Object.keys(rowsOf);
  for (let n = 0; n < emails.length; n++) {
    if (Date.now() - started > 4.5 * 60000) { log.push('Stopped: time limit. Press Run again to continue.'); break; }
    const email = emails[n];
    // Rows that were mailed and have no follow-up result yet.
    const open = rowsOf[email].filter(function (i) {
      return /sent/i.test(String(data[i][col.status])) && (col.followup < 0 || !String(data[i][col.followup]).trim());
    });
    if (!open.length) continue;

    const info = fuLastMail_(email);
    if (!info) { count.unknown++; log.push(email + ': no mail to this address found in Gmail Sent. Left alone.'); continue; }
    const days = Math.floor((Date.now() - info.date.getTime()) / 86400000);
    let mark;
    if (info.bounced) { mark = '⚠ Bounced'; count.bounced++; }
    else if (info.replied) { mark = '💬 Replied'; count.replied++; }
    else if (days > FU_MAX_AGE_DAYS) { mark = '⏹ Too old (' + days + ' days)'; count.old++; }
    else if (days < FU_AFTER_DAYS) { count.early++; continue; }
    else if (count.sent >= FU_MAX_PER_RUN) { log.push(email + ': due, but the limit of ' + FU_MAX_PER_RUN + ' per run is reached.'); continue; }
    else {
      const row = data[open[open.length - 1]];
      if (send) { fuSend_(email, row, col, info, tz); Utilities.sleep(2000); }
      count.sent++;
      mark = '📨 Followed up ' + Utilities.formatDate(new Date(), tz, 'd MMM');
    }
    log.push(email + ': ' + mark + ' (your mail was ' + days + ' day(s) ago)');
    if (send) open.forEach(function (i) { sheet.getRange(i + 2, col.followup + 1).setValue(mark); });
  }

  console.log((send ? 'DONE. ' : 'PREVIEW ONLY, nothing was sent or written. ') +
    (send ? 'Follow-ups sent: ' : 'Would get a follow-up: ') + count.sent +
    ' | replied: ' + count.replied + ' | bounced: ' + count.bounced +
    ' | too early (under ' + FU_AFTER_DAYS + ' days): ' + count.early +
    ' | too old: ' + count.old + ' | not found in Gmail: ' + count.unknown);
  if (log.length) console.log(log.join('\n'));
}

/**
 * Your most recent mail to an address, from Gmail's Sent.
 * Returns { date, first (your first message of that conversation), from, replied, bounced } or null.
 */
function fuLastMail_(email) {
  const threads = GmailApp.search('in:sent to:' + email, 0, 5);
  let best = null;
  threads.forEach(function (thread) {
    const msgs = thread.getMessages().filter(function (m) { return !m.isDraft(); });
    const mine = msgs.filter(function (m) { return String(m.getTo()).toLowerCase().indexOf(email) !== -1; });
    if (!mine.length) return;
    const lastMine = mine[mine.length - 1];
    if (best && lastMine.getDate().getTime() <= best.date.getTime()) return;
    const me = fuAddress_(lastMine.getFrom());
    const others = msgs.map(function (m) { return fuAddress_(m.getFrom()); }).filter(function (a) { return a !== me; });
    const bounced = others.some(function (a) { return /mailer-daemon|postmaster/.test(a); });
    best = {
      date: lastMine.getDate(), first: mine[0], from: lastMine.getFrom(),
      bounced: bounced, replied: !bounced && others.length > 0
    };
  });
  return best;
}

/** "Asha Rao <asha@x.com>" -> "asha@x.com" */
function fuAddress_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

/** "Asha Rao <asha@x.com>" -> "Asha Rao" (empty when the header has no name) */
function fuName_(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}

function fuSend_(email, row, col, info, tz) {
  const first = String(row[col.recruiter] == null ? '' : row[col.recruiter]).trim().split(/\s+/)[0] || '';
  const hello = /^[A-Za-z][A-Za-z.'-]{1,}$/.test(first) ? first : 'there';
  const company = col.company >= 0 ? String(row[col.company]).trim() : '';
  const role = col.role >= 0 ? String(row[col.role]).trim() : '';
  const when = Utilities.formatDate(info.date, tz, 'd MMMM');
  const about = (role ? 'the ' + role + ' role' : 'relevant openings') + (company ? ' at ' + company : '');
  const files = info.first.getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter(function (a) { return a.getSize() < 5 * 1024 * 1024; });
  const myName = fuName_(info.from);
  const body = 'Hi ' + hello + ',\n\n' +
    'I wrote to you on ' + when + ' about ' + about + ' and wanted to follow up. ' +
    'I am still interested and would be glad to share any details you need.' +
    (files.length ? ' My resume is attached again for convenience.' : '') + '\n\n' +
    'Thank you for your time.\n\n' +
    'Regards' + (myName ? ',\n' + myName : '');
  const subject = info.first.getSubject();
  GmailApp.sendEmail(email, /^re:/i.test(subject) ? subject : 'Re: ' + subject, body, { attachments: files });
}
