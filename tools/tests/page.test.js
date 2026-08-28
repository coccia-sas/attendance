// Retry tests for the student page in docs/index.html.
//
// The page runs on a clock this file controls, so a 45 second retry campaign
// finishes instantly and the timings can be checked exactly.
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..', '..');
var HTML = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
var OPEN = HTML.indexOf('<script>', HTML.indexOf('config.js'));
var JS = HTML.slice(OPEN + '<script>'.length, HTML.indexOf('</script>', OPEN));

function run(respond, opts) {
  opts = opts || {};
  var els = {}, handlers = {}, calls = 0, now = 0, timers = [];

  function node(text) {
    var n = { textContent: text || '', className: '', style: {}, children: [],
      classList: { add: function () {}, remove: function () {} },
      appendChild: function (c) { n.children.push(c); },
      addEventListener: function () {}, focus: function () {}, setAttribute: function () {} };
    return n;
  }

  function el(id) {
    if (!els[id]) {
      var e = node();
      e.value = '';
      e.disabled = false;
      Object.defineProperty(e, 'innerHTML', {
        set: function () { e.children = []; },
        get: function () { return ''; }
      });
      e.text = function () {
        return e.children.map(function (c) { return c.textContent; }).join(' ').trim();
      };
      e.addEventListener = function (type, fn) { handlers[id + ':' + type] = fn; };
      els[id] = e;
    }
    return els[id];
  }

  global.document = {
    getElementById: el, querySelector: el, addEventListener: function () {},
    createElement: function () { return node(); },
    createTextNode: function (t) { return node(t); },
    body: el('body')
  };
  global.window = {
    location: { search: '?c=FINA3000-02' },
    ATTENDANCE_CONFIG: {
      apiUrl: 'https://example/exec', term: 'Fall 2026',
      classes: { 'FINA3000-02': { label: 'FINA 3000 Section 2', meets: '4:00-5:15 M/W' } }
    }
  };
  global.location = global.window.location;
  global.localStorage = {
    _d: {},
    getItem: function (k) { return this._d[k] || null; },
    setItem: function (k, v) { this._d[k] = v; },
    removeItem: function (k) { delete this._d[k]; }
  };
  // Node defines navigator and crypto as read-only globals, so overwrite them
  // through defineProperty rather than plain assignment.
  Object.defineProperty(global, 'navigator', {
    value: { userAgent: 'test' }, configurable: true, writable: true });
  Object.defineProperty(global, 'crypto', {
    value: {
      randomUUID: function () { return 'device-uuid-0000'; },
      getRandomValues: function (a) { return a; }
    }, configurable: true, writable: true });
  global.setTimeout = function (fn, ms) { timers.push({ at: now + (ms || 0), fn: fn }); };
  global.Date = { now: function () { return now; } };
  // Fixed, so the spread before the first send is the same on every run.
  global.Math = Object.create(Math);
  global.Math.random = function () { return opts.random === undefined ? 0.5 : opts.random; };
  global.fetch = function () {
    calls++;
    var answer = respond(calls);
    return Promise.resolve({
      json: function () {
        return answer === null
          ? Promise.reject(new Error('not JSON'))
          : Promise.resolve(answer);
      }
    });
  };

  // eslint-disable-next-line no-eval
  (0, eval)(JS);

  return {
    fill: function (id, code) { el('studentId').value = id; el('code').value = code; },
    submit: function () { handlers['form:submit']({ preventDefault: function () {} }); },
    calls: function () { return calls; },
    clock: function () { return now; },
    msg: function () { return el('msg').text(); },
    code: function () { return el('code').value; },
    button: function () { return el('submit'); },
    drain: function () {
      return new Promise(function (done) {
        var steps = 0;
        (function step() {
          setImmediate(function () {
            timers.sort(function (a, b) { return a.at - b.at; });
            if (timers.length && steps < 200) {
              var next = timers.shift();
              now = Math.max(now, next.at);
              steps++;
              next.fn();
              return step();
            }
            done();
          });
        })();
      });
    }
  };
}

var OK = { ok: true, already: false, status: 'enrolled', name: 'Ann', message: 'Present' };
var RETRY = { ok: false, retry: true, error: 'The class is busy right now.' };
var REFUSE = { ok: false, error: 'That code is wrong or expired.' };

module.exports = async function (t) {
  var p;

  // The server never recovers.
  p = run(function () { return RETRY; });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.ok('a server that never recovers is retried, then gives up',
       p.calls() > 4 && p.calls() < 20, 'tries=' + p.calls());
  t.ok('the trying lasts about 45 seconds',
       p.clock() >= 35000 && p.clock() <= 46000, 'campaign=' + p.clock() + 'ms');
  t.ok('it ends with a message, not a hang', p.msg().indexOf('Not counted') >= 0, p.msg());
  t.ok('the button works again', p.button().disabled === false);
  t.ok('the code box is cleared, because that code has rolled over', p.code() === '');

  // The server recovers part way through.
  p = run(function (n) { return n < 4 ? RETRY : OK; });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.ok('a check-in that works on the 4th try is reported as present',
       p.calls() === 4 && p.msg().indexOf('Present') >= 0,
       'tries=' + p.calls() + ' msg=' + p.msg());
  t.ok('the student is never asked to do anything', p.msg().indexOf('Ann') >= 0, p.msg());

  // Apps Script answers with an error page instead of JSON. That is what a
  // burst over the 30 simultaneous executions produces.
  p = run(function (n) { return n < 3 ? null : OK; });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.ok('an answer that is not JSON is retried too',
       p.calls() === 3 && p.msg().indexOf('Present') >= 0, 'tries=' + p.calls());

  // A real refusal must not loop.
  p = run(function () { return REFUSE; });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.eq('a wrong code is sent once, not retried', p.calls(), 1);
  t.ok('the student is told what to fix', p.msg().indexOf('wrong') >= 0, p.msg());

  // A repeat is reported once.
  p = run(function () { return { ok: true, already: true, status: 'enrolled', name: 'Cy' }; });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.ok('a repeat is reported once',
       p.calls() === 1 && p.msg().indexOf('Already counted') >= 0, p.msg());

  // The spread before the first send.
  p = run(function () { return OK; }, { random: 0 });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  var earliest = p.clock();

  p = run(function () { return OK; }, { random: 0.999 });
  p.fill('20000001', '123456');
  p.submit();
  await p.drain();
  t.ok('the first send is spread, so taps do not land together',
       earliest === 0 && p.clock() > 1000 && p.clock() <= 1500,
       'earliest=' + earliest + 'ms latest=' + p.clock() + 'ms');
};
