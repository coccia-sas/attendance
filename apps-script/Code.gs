/**
 * Attendance backend for any course-section.
 *
 * Runs as a Google Apps Script web app bound to a Google Sheet.
 * The Sheet holds three tabs: Roster, Attendance, Sessions.
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

// During add and drop, a student who just registered is not on your roster yet.
// While this is true, that student is still recorded, with Status "pending",
// and is told to see you after class. Set it to false once the roster settles,
// which for Fall 2026 is after September 4.
var ALLOW_UNROSTERED = true;

// Tab names inside the bound Sheet.
var ROSTER_TAB = 'Roster';
var ATTENDANCE_TAB = 'Attendance';
var SESSIONS_TAB = 'Sessions';

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

function today_() {
  var tz = book_().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function stamp_() {
  var tz = book_().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
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
    return Utilities.formatDate(value, book_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  var text = String(value == null ? '' : value).trim();
  var iso = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  var parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, book_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
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

function attendanceTab_() {
  var sheet = tab_(ATTENDANCE_TAB,
    ['At', 'Date', 'Class', 'StudentID', 'Name', 'Status', 'Window', 'Device']);
  // Hold the date and the ID as plain text. Otherwise Sheets turns the date
  // into a date value and strips a leading zero from a student ID.
  if (!props_().getProperty('FORMATTED_ATTENDANCE')) {
    sheet.getRange('A:D').setNumberFormat('@');
    props_().setProperty('FORMATTED_ATTENDANCE', 'yes');
  }
  return sheet;
}

/**
 * Today's rows for one class, as { studentId: status }.
 */
function presentToday_(classId) {
  var sheet = attendanceTab_();
  var last = sheet.getLastRow();
  var seen = {};
  if (last < 2) return seen;
  // Columns 2..6 are Date, Class, StudentID, Name, Status.
  var rows = sheet.getRange(2, 2, last - 1, 5).getValues();
  var day = today_();
  for (var i = 0; i < rows.length; i++) {
    if (dayKey_(rows[i][0]) !== day) continue;
    if (normClass_(rows[i][1]) !== classId) continue;
    seen[normId_(rows[i][2])] = String(rows[i][4] || 'enrolled');
  }
  return seen;
}

function checkin_(params) {
  var classId = normClass_(params.classId);
  var studentId = normId_(params.studentId);
  var device = String(params.device || '').slice(0, 40);

  if (!classId) return { ok: false, error: 'This link is missing its class. Scan the QR code on the screen.' };
  if (!studentId) return { ok: false, error: 'Enter your student ID number.' };

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

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var already = presentToday_(classId)[studentId];
    if (already) {
      return {
        ok: true, already: true, status: already,
        name: firstName_(student ? student.name : ''),
        message: 'You were already marked present today.'
      };
    }
    attendanceTab_().appendRow([
      stamp_(), today_(), classId, studentId,
      student ? student.name : '',
      student ? 'enrolled' : 'pending',
      windowIndex_(Date.now()), device
    ]);
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    already: false,
    status: student ? 'enrolled' : 'pending',
    name: firstName_(student ? student.name : ''),
    message: student
      ? 'Present'
      : 'Recorded, but you are not on my roster yet. See me after class so I can fix it.'
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
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * The student page posts here with Content-Type text/plain, which keeps the
 * request "simple" and avoids a CORS preflight that Apps Script cannot answer.
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action !== 'checkin') {
      return json_({ ok: false, error: 'Unknown action.' });
    }
    return json_(checkin_(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- one-time setup, run from the editor ----------

/**
 * Run this once from the Apps Script editor. It creates the tabs and generates
 * a SECRET and an INSTRUCTOR_KEY, then prints the key to the log.
 */
function setup() {
  tab_(ROSTER_TAB, ['Class', 'StudentID', 'Name', 'Email']);
  attendanceTab_();
  tab_(SESSIONS_TAB, ['Date', 'Class', 'Action', 'At']);

  var p = props_();
  if (!p.getProperty('SECRET')) {
    p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!p.getProperty('INSTRUCTOR_KEY')) {
    p.setProperty('INSTRUCTOR_KEY', Utilities.getUuid().split('-')[0]);
  }
  Logger.log('SECRET is set. INSTRUCTOR_KEY = ' + p.getProperty('INSTRUCTOR_KEY'));
}
