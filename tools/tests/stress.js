// Load simulation for the check-in path.
//
//   node tools/tests/stress.js
//
// The logic tests prove what the code answers. This one asks a different
// question: does a whole class get marked present when everybody taps at once,
// and where does it stop working?
//
// It runs the real checkin_ from Code.gs against the stubbed services, on a
// simulated clock. It models the three things that actually limit the system:
//
//   1. Google runs 30 of your executions at one instant. Request 31 is refused
//      before your script runs.
//   2. Every check-in queues on one lock to append its row.
//   3. A student waiting on the lock still holds one of the 30.
//
// It reads the timing constants out of Code.gs and index.html, so it fails
// loudly if somebody changes them without thinking about load.
'use strict';
var fs = require('fs'), path = require('path');
var makeEnv = require('./stubs.js').makeEnv;

var ROOT = path.join(__dirname, '..', '..');
var CODE = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
var PAGE = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

// ---------- the constants that matter, read from the source ----------

function num(src, name) {
  var m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\d+)'));
  if (!m) throw new Error('cannot find ' + name);
  return Number(m[1]);
}
function list(src, name) {
  var m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*\\[([^\\]]+)\\]'));
  if (!m) throw new Error('cannot find ' + name);
  return m[1].split(',').map(function (s) { return Number(s.trim()); });
}

var LOCK_WAIT_MS = num(CODE, 'LOCK_WAIT_MS');
var APPEND_TRIES = num(CODE, 'APPEND_TRIES');
var SPREAD_MS = num(PAGE, 'SPREAD_MS');
var RETRY_DEADLINE_MS = num(PAGE, 'RETRY_DEADLINE_MS');
var BACKOFF_MS = list(PAGE, 'BACKOFF_MS');

// Google's published limit, from the Apps Script quotas page.
var SIMULTANEOUS_LIMIT = 30;

// ---------- the simulation ----------

function simulate(cfg) {
  var env = makeEnv();
  // eslint-disable-next-line no-eval
  (0, eval)(CODE + '\n;global.__api = { checkin_: checkin_, openSession_: openSession_,' +
            ' codeFor_: codeFor_, windowIndex_: windowIndex_, setup: setup,' +
            ' presentToday_: presentToday_, report_: report_ };');
  var api = global.__api;

  var CLASS = 'FINA3000-02';
  api.setup();
  env.tabs.Roster.rows.length = 0;
  env.tabs.Roster.rows.push(['Class', 'StudentID', 'Name', 'Email']);
  for (var i = 1; i <= cfg.students; i++) {
    env.tabs.Roster.rows.push([CLASS, id(i), 'Student ' + i, 's@x.edu']);
  }
  api.openSession_(CLASS);
  var code = api.codeFor_(CLASS, api.windowIndex_(Date.now()));

  function id(n) { return '2' + String(n).padStart(7, '0'); }

  // A tiny event loop on a simulated clock.
  var now = 0, queue = [];
  function at(t, fn) { queue.push({ t: t, fn: fn, seq: queue.length }); }
  function nextEvent() {
    if (!queue.length) return null;
    queue.sort(function (a, b) { return a.t - b.t || a.seq - b.seq; });
    return queue.shift();
  }

  // Random, but the same on every run, so a result is reproducible.
  var seed = cfg.seed || 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function jitter(base) { return base * (0.6 + 0.8 * rnd()); }

  var inFlight = 0, peakInFlight = 0, lockFreeAt = 0;
  var refusedByGoogle = 0, refusedByLock = 0, networkDrops = 0, totalRequests = 0;
  var done = {}, sends = {}, firstTap = {}, settledAt = {};

  function finish(student, ok, t) {
    done[student] = ok;
    settledAt[student] = t - firstTap[student];
  }

  // One attempt by one student's phone.
  function send(student, attempt, t) {
    sends[student] = (sends[student] || 0) + 1;
    totalRequests++;

    var giveUpAt = firstTap[student] + SPREAD_MS + RETRY_DEADLINE_MS;

    function retryOrFail(t2) {
      var wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (t2 + wait > giveUpAt) return finish(student, false, t2);
      at(t2 + wait, function () { send(student, attempt + 1, t2 + wait); });
    }

    // The request travels to Google.
    var upAt = t + jitter(cfg.networkMs);

    at(upAt, function () {
      // A phone on a weak signal loses some requests outright.
      if (rnd() < cfg.dropRate) {
        networkDrops++;
        return at(upAt + cfg.networkMs, function () { retryOrFail(upAt + cfg.networkMs); });
      }
      // Google refuses anything past its simultaneous limit before the script runs.
      if (inFlight >= SIMULTANEOUS_LIMIT) {
        refusedByGoogle++;
        return at(upAt + cfg.networkMs, function () { retryOrFail(upAt + cfg.networkMs); });
      }

      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;

      // The work before the lock: read the roster cache, look for a repeat.
      var reachLock = upAt + jitter(cfg.preLockMs);
      var got = lockFreeAt <= reachLock;
      var acquireAt = got ? reachLock : lockFreeAt;
      var waited = acquireAt - reachLock;

      if (!got && waited > LOCK_WAIT_MS) {
        // tryLock gives up. The execution ends and the slot goes back.
        var endAt = reachLock + LOCK_WAIT_MS;
        refusedByLock++;
        return at(endAt, function () {
          inFlight--;
          env.locked = true;                  // make the real tryLock answer false
          var res = api.checkin_({ classId: CLASS, studentId: id(student), code: code, device: 'd' });
          env.locked = false;
          if (!res.ok && res.retry) return at(endAt + cfg.networkMs, function () {
            retryOrFail(endAt + cfg.networkMs);
          });
          finish(student, res.ok, endAt);
        });
      }

      // The lock is had. The append holds it.
      var hold = jitter(cfg.appendMs);
      lockFreeAt = acquireAt + hold;
      var endAt2 = lockFreeAt;
      at(endAt2, function () {
        inFlight--;
        var res = api.checkin_({ classId: CLASS, studentId: id(student), code: code, device: 'd' });
        if (!res.ok && res.retry) {
          return at(endAt2 + cfg.networkMs, function () { retryOrFail(endAt2 + cfg.networkMs); });
        }
        if (!res.ok) return finish(student, false, endAt2);
        finish(student, true, endAt2);
      });
    });
  }

  // Everybody taps. arrivalMs 0 means the whole class taps at the same instant.
  for (var s = 1; s <= cfg.students; s++) {
    (function (student) {
      var tap = cfg.arrivalMs === 0 ? 0 : rnd() * cfg.arrivalMs;
      firstTap[student] = tap;
      var spread = rnd() * SPREAD_MS;
      at(tap + spread, function () { send(student, 0, tap + spread); });
    })(s);
  }

  var guard = 0;
  while (queue.length && guard++ < 400000) {
    var e = nextEvent();
    now = Math.max(now, e.t);
    e.fn();
  }

  var present = api.presentToday_(CLASS);
  var rows = env.tabs.Attendance.rows.length - 1;
  var marked = Object.keys(present).length;
  var lost = [];
  for (var k = 1; k <= cfg.students; k++) if (!present[id(k)]) lost.push(k);
  var waits = Object.keys(settledAt).map(function (k) { return settledAt[k]; }).sort(function (a, b) { return a - b; });

  return {
    students: cfg.students, marked: marked, lost: lost.length, rows: rows,
    duplicateRows: rows - marked,
    peakInFlight: peakInFlight, refusedByGoogle: refusedByGoogle,
    refusedByLock: refusedByLock, networkDrops: networkDrops,
    requests: totalRequests,
    medianWait: Math.round(waits[Math.floor(waits.length / 2)] || 0),
    worstWait: Math.round(waits[waits.length - 1] || 0),
    finishedAt: Math.round(now)
  };
}

// ---------- the runs ----------

var BASE = { students: 40, arrivalMs: 0, networkMs: 120, preLockMs: 250, appendMs: 200, dropRate: 0, seed: 7 };

function show(label, r) {
  var flag = r.lost === 0 ? 'ok  ' : 'LOST';
  console.log('  ' + flag + '  ' + pad(label, 42) +
    'marked ' + pad(r.marked + '/' + r.students, 8) +
    'worst wait ' + pad((r.worstWait / 1000).toFixed(1) + 's', 8) +
    'peak ' + pad(String(r.peakInFlight), 4) +
    'refused ' + pad(r.refusedByGoogle + '+' + r.refusedByLock, 8) +
    'dup rows ' + r.duplicateRows);
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

console.log('\nconstants in use');
console.log('  lock wait ' + LOCK_WAIT_MS + 'ms, append tries ' + APPEND_TRIES +
            ', page spread ' + SPREAD_MS + 'ms, retry deadline ' + RETRY_DEADLINE_MS + 'ms');
console.log('  backoff ' + BACKOFF_MS.join(', ') + 'ms');

console.log('\n1. a 40 student class, everybody taps at the same instant');
show('fast Sheets  (append 100ms)', simulate(Object.assign({}, BASE, { appendMs: 100 })));
show('likely       (append 200ms)', simulate(BASE));
show('slow         (append 400ms)', simulate(Object.assign({}, BASE, { appendMs: 400 })));
show('very slow    (append 800ms)', simulate(Object.assign({}, BASE, { appendMs: 800 })));

console.log('\n2. realistic arrival, students tap across 20 seconds');
show('likely       (append 200ms)', simulate(Object.assign({}, BASE, { arrivalMs: 20000 })));
show('very slow    (append 800ms)', simulate(Object.assign({}, BASE, { arrivalMs: 20000, appendMs: 800 })));

console.log('\n3. bigger classes, everybody at the same instant, append 200ms');
[60, 100, 150, 200].forEach(function (n) {
  show(n + ' students', simulate(Object.assign({}, BASE, { students: n })));
});

console.log('\n4. a bad room: one request in five is dropped by the phone signal');
show('40 students, 20% drops', simulate(Object.assign({}, BASE, { dropRate: 0.2 })));
show('40 students, 40% drops', simulate(Object.assign({}, BASE, { dropRate: 0.4 })));

console.log('\n5. where it breaks: how slow can the append get before anybody is lost');
var breakAt = null;
for (var ms = 100; ms <= 4000; ms += 100) {
  var r = simulate(Object.assign({}, BASE, { appendMs: ms }));
  if (r.lost > 0) { breakAt = { ms: ms, r: r }; break; }
}
if (breakAt) {
  console.log('  the first student is lost when one append takes ' + breakAt.ms + 'ms');
  show('at that point', breakAt.r);
} else {
  console.log('  nobody is lost even at 4000ms per append');
}

console.log('');
