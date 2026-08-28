// Check-in tests for apps-script/Code.gs.
//
// The point of these is the failure paths. A student must never read a Google
// service message, and a check-in must never be lost to one that is retryable.
'use strict';
var fs = require('fs'), path = require('path');
var makeEnv = require('./stubs.js').makeEnv;

var ROOT = path.join(__dirname, '..', '..');
var SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
var CLASS = 'FINA3000-02';

function load(check) {
  var env = makeEnv();
  var api = {};
  // eslint-disable-next-line no-eval
  (0, eval)(SRC + '\n;Object.assign(this.__api = {}, {' + [
    'checkin_', 'doPost', 'doGet', 'presentToday_', 'report_', 'openSession_',
    'closeSession_', 'codeFor_', 'windowIndex_', 'setup', 'reconcilePending_'
  ].map(function (n) { return n + ':' + n; }).join(',') + '});');
  Object.assign(api, global.__api);
  env.api = api;

  api.setup();
  env.tabs.Roster.rows.push(['Class', 'StudentID', 'Name', 'Email']);
  for (var i = 1; i <= 40; i++) {
    env.tabs.Roster.rows.push([CLASS, '200000' + String(i).padStart(2, '0'), 'Student ' + i, 's@x.edu']);
  }
  // setup() wrote headers; Roster got a second header row above, drop the first
  env.tabs.Roster.rows.splice(0, 1);
  api.openSession_(CLASS);
  env.code = api.codeFor_(CLASS, api.windowIndex_(Date.now()));
  env.post = function (id, code) {
    var out = api.doPost({ postData: { contents: JSON.stringify({
      action: 'checkin', classId: CLASS, studentId: id, code: code || env.code, device: 'dev'
    }) } });
    return JSON.parse(out.getContent());
  };
  env.attendanceRows = function () { return env.tabs.Attendance.rows.length - 1; };
  env.id = function (n) { return '200000' + String(n).padStart(2, '0'); };
  return env;
}

module.exports = function (t) {
  var e;

  e = load();
  for (var i = 1; i <= 40; i++) e.post(e.id(i));
  t.eq('40 students produce 40 rows', e.attendanceRows(), 40);
  t.eq('the report counts 40 present', e.api.report_(CLASS).presentCount, 40);

  t.ok('a repeat is caught and adds no row',
       e.post(e.id(1)).already === true && e.attendanceRows() === 40);
  e.cache = {};
  t.ok('a repeat is still caught with the cache empty',
       e.post(e.id(1)).already === true && e.attendanceRows() === 40);

  // Service calls on the hot path, after the first check-in warms the globals.
  e.propGets = 0; e.tzCalls = 0;
  e.post(e.id(2));
  t.ok('a later check-in makes few service calls, tz=' + e.tzCalls + ' props=' + e.propGets,
       e.tzCalls === 0 && e.propGets <= 2);

  // The lock is held by another execution.
  e.locked = true;
  var busy = e.post('29999991');
  t.ok('a held lock answers retry, not an error', busy.ok === false && busy.retry === true);
  t.ok('the busy message names no Google service',
       !/lock|timeout|exception|service/i.test(busy.error), busy.error);
  e.locked = false;
  t.ok('the retry after a held lock succeeds', e.post('29999991').ok === true);

  // The Sheets service fails, then recovers.
  e.failAppends = 2;
  var before = e.attendanceRows();
  t.ok('two failed appends recover on the third try',
       e.post('29999992').ok === true && e.attendanceRows() === before + 1);

  // The Sheets service never recovers.
  e.failAppends = 99;
  var dead = e.post('29999993');
  e.failAppends = 0;
  t.ok('an append that always fails answers retry', dead.ok === false && dead.retry === true);
  t.ok('no service text reaches the student',
       !/Spreadsheets|Service|Exception/.test(dead.error), dead.error);
  t.ok('the failure lands on the Errors tab',
       e.tabs.Errors && e.tabs.Errors.rows.length === 2,
       e.tabs.Errors ? String(e.tabs.Errors.rows[1] && e.tabs.Errors.rows[1][4]) : 'no tab');

  // Anything unplanned inside the check-in.
  e = load();
  var real = global.presentToday_;
  global.presentToday_ = function () { throw new Error('Lock timeout: another process was holding the lock'); };
  var boom = e.post(e.id(1));
  global.presentToday_ = real;
  t.ok('an unexpected exception answers retry', boom.ok === false && boom.retry === true);
  t.ok('the raw exception never reaches the student',
       boom.error.indexOf('Lock timeout') < 0, boom.error);

  // Real refusals must not be retryable, or the page would loop for nothing.
  e = load();
  var wrong = e.post(e.id(1), '000000');
  t.ok('a wrong code is a refusal, not a retry', wrong.ok === false && !wrong.retry, wrong.error);
  t.ok('a short student ID is a refusal, not a retry',
       (function (r) { return r.ok === false && !r.retry; })(e.post('123', '000000')));
  e.api.closeSession_(CLASS);
  t.ok('a closed class is a refusal, not a retry',
       (function (r) { return r.ok === false && !r.retry; })(e.post(e.id(2))));
  e.api.openSession_(CLASS);

  // Bad input must not throw.
  t.ok('a malformed body does not throw',
       JSON.parse(e.api.doPost({ postData: { contents: '{not json' } }).getContent()).ok === false);
  t.ok('a missing body does not throw',
       JSON.parse(e.api.doPost({}).getContent()).ok === false);

  // The row scan must stop at the first earlier day.
  e = load();
  for (var k = 0; k < 3000; k++) {
    e.tabs.Attendance.rows.push(['t', '2026-08-20', CLASS, '9' + k, 'Old', 'enrolled', 1, 'd']);
  }
  e.post(e.id(3));
  e.cache = {}; e.tzCalls = 0;
  var seen = e.api.presentToday_(CLASS);
  t.ok('the scan over 3000 old rows reads the time zone once, not per row', e.tzCalls <= 1,
       'tzCalls=' + e.tzCalls);
  t.eq('the scan finds only today', Object.keys(seen).length, 1);

  // A Date object in the Date column, which is what Sheets hands back.
  e.tabs.Attendance.rows.push(['t', new Date(), CLASS, '88888888', 'D', 'enrolled', 1, 'd']);
  t.ok('a real Date cell still counts', !!e.api.presentToday_(CLASS)['88888888']);
};
