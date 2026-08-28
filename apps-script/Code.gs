/**
 * Attendance backend for any course-section.
 *
 * Runs as a Google Apps Script web app bound to a Google Sheet.
 * The Sheet holds four tabs: Roster, Attendance, Sessions, Errors.
 * The static pages on GitHub Pages call this script. No other server.
 *
 * A "class id" identifies one course-section, for example FIN331-02. One Sheet
 * and one deployment serve every class you teach.
 *
 * Setup is in ../README.md. Do not paste the secret into the web pages.
 */

// ---------- configuration ----------

// How long one projector code stays on screen, in seconds.
var WINDOW_SECONDS = 60;

// How many expired windows are still accepted. 1 gives a student who starts
// typing at the end of a window up to WINDOW_SECONDS extra to finish.
var GRACE_WINDOWS = 1;

// How many digits a student ID has. Every ID on both Fall 2026 rolls has 8.
// A number of any other length is a typo, not a student who just registered,
// so it is refused rather than filed as pending. Set it to 0 to skip the check.
var STUDENT_ID_DIGITS = 8;

// During add and drop, a student who just registered is not on your roster yet.
// While this is true, that student is still recorded, with Status "pending",
// and is told to see you after class. Set it to false once the roster settles,
// which for Fall 2026 is after September 4.
var ALLOW_UNROSTERED = true;

// How long a check-in waits for the lock, in milliseconds.
//
// Short on purpose. A student waiting on the lock still holds one of the 30
// executions Google runs for you at a time, so a long wait is what creates a
// crowd, not what survives one. The append takes well under a second, so 6
// seconds already lets a long queue drain ahead of you. If it does not, giving
// the slot back beats holding it: the page sends the check-in again, and by
// then the crowd has thinned.
var LOCK_WAIT_MS = 6000;

// What a student sees when the server cannot write the row right now. The page
// sends the check-in again on its own, so a student rarely reads this.
var BUSY_MESSAGE = 'The class is busy right now. Wait a few seconds, read the '
                 + 'code on the screen again, and press the button again.';

// How many times the append is tried, and the pause between tries. This covers
// a Sheets service that fails for a moment. It runs while the lock is held, so
// it stays short.
var APPEND_TRIES = 3;
var APPEND_PAUSE_MS = 300;

// How many attendance rows to read at a time when looking for today's rows.
var SCAN_CHUNK_ROWS = 500;

// Tab names inside the bound Sheet.
var ROSTER_TAB = 'Roster';
var ATTENDANCE_TAB = 'Attendance';
var SESSIONS_TAB = 'Sessions';
var ERRORS_TAB = 'Errors';

// ---------- small helpers ----------

function props_() {
  return PropertiesService.getScriptProperties();
}

function book_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function tab_(name, headers) {
  var sheet = book_().getSheetByName(name);
  if (!sheet) {
    sheet = book_().insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * The Sheet time zone, read once per execution and then held.
 *
 * Reading the time zone is a call to the Sheets service, not a local read.
 * dayKey_ needs the zone for every row it looks at, so an uncached read cost
 * one service call per attendance row. That is what made a check-in slow
 * enough to time out the lock on a busy day.
 */
var TZ_ = null;

function tz_() {
  if (!TZ_) TZ_ = book_().getSpreadsheetTimeZone();
  return TZ_;
}

function today_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function stamp_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

/**
 * A cell from the Date column, as "yyyy-MM-dd".
 *
 * The script writes the date as text, but Sheets converts a value that looks
 * like a date into a real date. Reading it back then yields a Date object, and
 * String(thatDate) gives "Sun Aug 24 2026 ...", which never matches the text we
 * compare against. Every row would fail to match, so the day's tally read zero
 * and repeat check-ins were not caught. Normalise on read, and accept either
 * shape so rows written before this fix still count.
 */
function dayKey_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, tz_(), 'yyyy-MM-dd');
  }
  var text = String(value == null ? '' : value).trim();
  var iso = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, tz_(), 'yyyy-MM-dd');
  }
  return text;
}

function requireKey_(params) {
  var expected = props_().getProperty('INSTRUCTOR_KEY');
  if (!expected) throw new Error('INSTRUCTOR_KEY is not set in Script Properties.');
  if (params.key !== expected) throw new Error('Bad instructor key.');
}

function normId_(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function normClass_(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

/**
 * The first name only.
 *
 * The check-in reply goes to whoever sent the request, so it must not hand back
 * a full name. Anyone in the room holds a valid code for 60 seconds, and a
 * reply carrying "Last, First" would turn that into a way to harvest student
 * names by probing ID numbers. A first name still lets a student catch a
 * mistyped ID. The Sheet keeps the full name.
 *
 * Handles "Last, First" from Blackboard and "First Last" from other rolls.
 */
function firstName_(full) {
  var name = String(full || '').trim();
  if (!name) return '';
  if (name.indexOf(',') !== -1) {
    return name.split(',')[1].trim().split(/\s+/)[0];
  }
  return name.split(/\s+/)[0];
}

// ---------- rotating code ----------

function windowIndex_(millis) {
  return Math.floor(millis / (WINDOW_SECONDS * 1000));
}

/**
 * Six digits derived from the shared secret, the class id, and the time window.
 * The secret never leaves this script, so nobody can precompute future codes.
 * Two classes that meet at the same hour get different codes.
 */
function codeFor_(classId, widx) {
  var secret = props_().getProperty('SECRET');
  if (!secret) throw new Error('SECRET is not set in Script Properties.');
  var raw = Utilities.computeHmacSha256Signature(classId + ':' + widx, secret);
  var n = 0;
  for (var i = raw.length - 4; i < raw.length; i++) {
    n = (n * 256) + (raw[i] & 0xff);
  }
  return ('000000' + (n % 1000000)).slice(-6);
}

function codeIsValid_(classId, submitted) {
  var clean = normId_(submitted);
  if (clean.length !== 6) return false;
  var now = windowIndex_(Date.now());
  for (var back = 0; back <= GRACE_WINDOWS; back++) {
    if (codeFor_(classId, now - back) === clean) return true;
  }
  return false;
}

// ---------- session open and close ----------

function openKey_(classId) {
  return 'OPEN_' + classId;
}

function sessionOpen_(classId) {
  return props_().getProperty(openKey_(classId)) === today_();
}

function openSession_(classId) {
  props_().setProperty(openKey_(classId), today_());
  tab_(SESSIONS_TAB, ['Date', 'Class', 'Action', 'At'])
    .appendRow([today_(), classId, 'open', stamp_()]);
}

function closeSession_(classId) {
  props_().deleteProperty(openKey_(classId));
  tab_(SESSIONS_TAB, ['Date', 'Class', 'Action', 'At'])
    .appendRow([today_(), classId, 'close', stamp_()]);
}

// ---------- roster ----------

/**
 * Returns { "FIN331-02": { "11032915": {name: "...", email: "..."} }, ... }
 */
function rosterMap_() {
  var cached = CacheService.getScriptCache().get('roster');
  if (cached) return JSON.parse(cached);

  var sheet = tab_(ROSTER_TAB, ['Class', 'StudentID', 'Name', 'Email']);
  var rows = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var classId = normClass_(rows[i][0]);
    var id = normId_(rows[i][1]);
    if (!classId || !id) continue;
    if (!map[classId]) map[classId] = {};
    map[classId][id] = {
      name: String(rows[i][2] || '').trim(),
      email: String(rows[i][3] || '').trim()
    };
  }
  CacheService.getScriptCache().put('roster', JSON.stringify(map), 300);
  return map;
}

function clearRosterCache_() {
  CacheService.getScriptCache().remove('roster');
}

// ---------- attendance ----------

// Set once the number format is known to be correct, so a check-in does not
// call the Properties service to ask again.
var FORMATTED_ = false;

function attendanceTab_() {
  var sheet = tab_(ATTENDANCE_TAB,
    ['At', 'Date', 'Class', 'StudentID', 'Name', 'Status', 'Window', 'Device']);
  // Hold the date and the ID as plain text. Otherwise Sheets turns the date
  // into a date value and strips a leading zero from a student ID.
  if (!FORMATTED_) {
    if (!props_().getProperty('FORMATTED_ATTENDANCE')) {
      sheet.getRange('A:D').setNumberFormat('@');
      props_().setProperty('FORMATTED_ATTENDANCE', 'yes');
    }
    FORMATTED_ = true;
  }
  return sheet;
}

/**
 * A note that one student is already present today.
 *
 * This is a shortcut, never the truth. CacheService can drop an entry at any
 * time, and it is empty after a redeploy. presentToday_ is the fallback and the
 * Sheet stays the record. The cache only saves the Sheet read on the second and
 * later taps, which is where the repeat traffic is.
 *
 * The key holds the day, so it cannot leak into tomorrow's class.
 */
function seenKey_(classId, studentId) {
  return 'seen|' + classId + '|' + today_() + '|' + studentId;
}

function seenGet_(classId, studentId) {
  return CacheService.getScriptCache().get(seenKey_(classId, studentId));
}

function seenPut_(classId, studentId, status) {
  // 21600 seconds is the CacheService maximum, and it is far longer than a
  // class meeting.
  CacheService.getScriptCache().put(seenKey_(classId, studentId), status, 21600);
}

/**
 * Today's rows for one class, as { studentId: status }.
 *
 * The scan runs backwards from the last row and stops at the first row from an
 * earlier day. The script only appends, so every row for today sits at the
 * bottom in time order. Reading the whole sheet instead got slower every class
 * meeting, and the check-in holds a lock while it reads.
 *
 * If you sort the Attendance tab by hand, this assumption breaks. Sort a copy.
 */
function presentToday_(classId) {
  var sheet = attendanceTab_();
  var last = sheet.getLastRow();
  var seen = {};
  if (last < 2) return seen;

  var day = today_();
  var bottom = last;

  while (bottom >= 2) {
    var top = Math.max(2, bottom - SCAN_CHUNK_ROWS + 1);
    // Columns 2..6 are Date, Class, StudentID, Name, Status.
    var rows = sheet.getRange(top, 2, bottom - top + 1, 5).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      var key = dayKey_(rows[i][0]);
      if (key && key !== day) return seen;
      if (key !== day) continue;
      if (normClass_(rows[i][1]) !== classId) continue;
      seen[normId_(rows[i][2])] = String(rows[i][4] || 'enrolled');
    }
    bottom = top - 1;
  }
  return seen;
}

/**
 * Appends one row, and tries again if the Sheets service refuses.
 *
 * A service call fails now and then for no reason the script can see. One
 * retry turns most of those into a normal check-in. Throws if every try fails,
 * and the caller then answers "retry", never a raw service message.
 */
function appendWithRetry_(sheet, row) {
  var last = null;
  for (var i = 0; i < APPEND_TRIES; i++) {
    try {
      sheet.appendRow(row);
      return;
    } catch (err) {
      last = err;
      if (i < APPEND_TRIES - 1) Utilities.sleep(APPEND_PAUSE_MS);
    }
  }
  throw last;
}

/**
 * Records a failure on the Errors tab, so you can see what went wrong during a
 * class instead of guessing from a student's account of it.
 *
 * Logging must never break the answer to the student. Every failure here is
 * swallowed on purpose.
 */
function logError_(where, classId, studentId, err) {
  try {
    var detail = String(err && err.message ? err.message : err);
    Logger.log(where + ' ' + classId + ' ' + studentId + ': ' + detail);
    tab_(ERRORS_TAB, ['At', 'Where', 'Class', 'StudentID', 'Detail'])
      .appendRow([stamp_(), where, classId, studentId, detail.slice(0, 500)]);
  } catch (ignored) {
    // Nothing to do. The student's answer matters more than the log.
  }
}

function checkin_(params) {
  var classId = normClass_(params.classId);
  var studentId = normId_(params.studentId);
  var device = String(params.device || '').slice(0, 40);

  if (!classId) return { ok: false, error: 'This link is missing its class. Scan the QR code on the screen.' };
  if (!studentId) return { ok: false, error: 'Enter your student ID number.' };

  if (STUDENT_ID_DIGITS && studentId.length !== STUDENT_ID_DIGITS) {
    return {
      ok: false,
      error: 'A student ID has ' + STUDENT_ID_DIGITS + ' digits, and you entered '
             + studentId.length + '. Check the number and try again.'
    };
  }

  if (!sessionOpen_(classId)) {
    return { ok: false, error: 'Check-in is closed for this class.' };
  }
  if (!codeIsValid_(classId, params.code)) {
    return { ok: false, error: 'That code is wrong or expired. Read the current code off the screen.' };
  }

  var student = (rosterMap_()[classId] || {})[studentId];

  if (!student && !ALLOW_UNROSTERED) {
    return {
      ok: false,
      error: 'ID ' + studentId + ' is not on the roster for this class. Check the number, then see me after class.'
    };
  }

  var name = firstName_(student ? student.name : '');

  // Repeat check, first from the cache and then from the Sheet. Both run
  // outside the lock. Reading the Sheet was the slow step, and holding the lock
  // across it made the whole class queue behind one reader.
  var already = seenGet_(classId, studentId);
  if (!already) already = presentToday_(classId)[studentId];
  if (already) {
    seenPut_(classId, studentId, already);
    return {
      ok: true, already: true, status: already, name: name,
      message: 'You were already marked present today.'
    };
  }

  var status = student ? 'enrolled' : 'pending';
  // The row and the sheet handle are both prepared before the lock, so the
  // locked section is one append and nothing else.
  var sheet = attendanceTab_();
  var row = [
    stamp_(), today_(), classId, studentId,
    student ? student.name : '', status,
    windowIndex_(Date.now()), device
  ];

  // The lock guards the append only. Two appends at the same instant can each
  // aim at the same last row, and one would overwrite the other, which loses a
  // student's attendance. That is why the lock stays.
  //
  // tryLock returns false. waitLock threw, and the raw message
  // ("Lock timeout: another process ...") went straight to the student's phone.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    // The page retries this on its own, so the student normally sees nothing.
    return { ok: false, retry: true, error: BUSY_MESSAGE };
  }
  try {
    appendWithRetry_(sheet, row);
  } catch (err) {
    // The Sheets service refused three times. Say so as a retry, not as a
    // refusal, because the student did nothing wrong and the page sends again.
    logError_('append', classId, studentId, err);
    return { ok: false, retry: true, error: BUSY_MESSAGE };
  } finally {
    lock.releaseLock();
  }
  seenPut_(classId, studentId, status);

  return {
    ok: true,
    already: false,
    status: status,
    name: name,
    message: student
      ? 'Present'
      : 'Recorded, but that ID is not on my roster. Double check your ID number. '
        + 'If it is correct, see me after class so I can fix the roster.'
  };
}

// ---------- reporting ----------

function report_(classId) {
  var roster = rosterMap_()[classId] || {};
  var present = presentToday_(classId);

  var rows = [];
  Object.keys(roster).forEach(function (id) {
    rows.push({ id: id, name: roster[id].name, present: !!present[id] });
  });
  rows.sort(function (a, b) { return a.name.localeCompare(b.name); });

  // Anyone who checked in but is not on the roster. During add and drop, this is
  // the list to act on.
  var pending = Object.keys(present).filter(function (id) { return !roster[id]; });

  return {
    ok: true,
    classId: classId,
    date: today_(),
    open: sessionOpen_(classId),
    allowUnrostered: ALLOW_UNROSTERED,
    enrolled: rows.length,
    presentCount: rows.filter(function (r) { return r.present; }).length,
    students: rows,
    pending: pending
  };
}

/**
 * Every attendance row, as CSV.
 */
function exportCsv_() {
  var rows = attendanceTab_().getDataRange().getValues();
  return rows.map(function (row) {
    return row.map(function (cell) {
      var s = String(cell == null ? '' : cell);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\n');
}

/**
 * Fill in the Name column for rows recorded before the student appeared on the
 * roster, and mark them enrolled. Runs whenever you reload the roster.
 * Returns how many rows it fixed.
 */
function reconcilePending_() {
  var sheet = attendanceTab_();
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var roster = rosterMap_();
  // Columns 3..6 are Class, StudentID, Name, Status.
  var range = sheet.getRange(2, 3, last - 1, 4);
  var values = range.getValues();
  var fixed = 0;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][3]) !== 'pending') continue;
    var student = (roster[normClass_(values[i][0])] || {})[normId_(values[i][1])];
    if (!student) continue;
    values[i][2] = student.name;
    values[i][3] = 'enrolled';
    fixed++;
  }
  if (fixed) range.setValues(values);
  return fixed;
}

// ---------- web entry points ----------

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || '';
  try {
    if (action === 'ping') {
      return json_({ ok: true, service: 'attendance' });
    }

    requireKey_(p);
    var classId = normClass_(p.classId);

    if (action === 'code') {
      var widx = windowIndex_(Date.now());
      var endsAt = (widx + 1) * WINDOW_SECONDS * 1000;
      return json_({
        ok: true,
        classId: classId,
        code: codeFor_(classId, widx),
        secondsLeft: Math.max(0, Math.round((endsAt - Date.now()) / 1000)),
        windowSeconds: WINDOW_SECONDS,
        open: sessionOpen_(classId),
        presentCount: Object.keys(presentToday_(classId)).length
      });
    }
    if (action === 'open') { openSession_(classId); return json_({ ok: true, open: true }); }
    if (action === 'close') { closeSession_(classId); return json_({ ok: true, open: false }); }
    if (action === 'report') { return json_(report_(classId)); }
    if (action === 'refreshRoster') {
      clearRosterCache_();
      return json_({ ok: true, reconciled: reconcilePending_() });
    }
    if (action === 'csv') {
      return ContentService.createTextOutput(exportCsv_())
        .setMimeType(ContentService.MimeType.CSV);
    }
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    // This one is for you, not for a student, so it keeps the raw detail.
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * The student page posts here with Content-Type text/plain, which keeps the
 * request "simple" and avoids a CORS preflight that Apps Script cannot answer.
 *
 * No raw service message leaves this function. A student once read
 * "Lock timeout: another process ..." on a phone, which said nothing useful and
 * told the student nothing to do. Every unplanned failure now reads as "retry",
 * the page sends the check-in again, and the detail goes to the Errors tab for
 * you.
 */
function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'The check-in did not arrive in one piece. Try again.' });
  }
  if (body.action !== 'checkin') {
    return json_({ ok: false, error: 'Unknown action.' });
  }
  try {
    return json_(checkin_(body));
  } catch (err) {
    logError_('checkin', String(body.classId || ''), String(body.studentId || ''), err);
    return json_({ ok: false, retry: true, error: BUSY_MESSAGE });
  }
}

// ---------- one-time setup, run from the editor ----------

/**
 * A 32 character key, which is 128 bits.
 *
 * The key guards every action except ping, and that includes reading the
 * current 6 digit code. A student who holds the key can therefore read the code
 * from anywhere and check in without being in the room, so the key is worth
 * protecting properly.
 */
function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

/**
 * Issues a fresh INSTRUCTOR_KEY and prints it to the log. Run it from the
 * editor whenever the old key may have been seen: it went into a browser
 * address bar, it sat in a shared classroom machine, or you simply want a new
 * one for the term.
 *
 * The old key stops working at once. Retype the new one on display.html and
 * admin.html. Nothing else changes, and no attendance data is touched.
 */
function rotateInstructorKey() {
  var key = newKey_();
  props_().setProperty('INSTRUCTOR_KEY', key);
  Logger.log('New INSTRUCTOR_KEY = ' + key);
  Logger.log('The old key no longer works. Retype this on display.html and admin.html.');
}

/**
 * Run this once from the Apps Script editor. It creates the tabs and generates
 * a SECRET and an INSTRUCTOR_KEY, then prints the key to the log.
 */
function setup() {
  tab_(ROSTER_TAB, ['Class', 'StudentID', 'Name', 'Email']);
  attendanceTab_();
  tab_(SESSIONS_TAB, ['Date', 'Class', 'Action', 'At']);
  tab_(ERRORS_TAB, ['At', 'Where', 'Class', 'StudentID', 'Detail']);

  var p = props_();
  if (!p.getProperty('SECRET')) {
    p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!p.getProperty('INSTRUCTOR_KEY')) {
    p.setProperty('INSTRUCTOR_KEY', newKey_());
  }
  Logger.log('SECRET is set. INSTRUCTOR_KEY = ' + p.getProperty('INSTRUCTOR_KEY'));
}
