// Stand-ins for the Google Apps Script services, so Code.gs runs under node.
//
// These are deliberately simple. They exist to prove the check-in logic, not to
// copy Google. Run the tests with:  node tools/tests/run.js
'use strict';

function makeEnv(options) {
  options = options || {};
  var env = {
    tabs: {}, cache: {}, props: { SECRET: 'test-secret', INSTRUCTOR_KEY: 'test-key' },
    locked: false, failAppends: 0, failOnTab: 'Attendance',
    tzCalls: 0, propGets: 0, slept: 0, lockDenials: 0
  };

  function makeTab(name) {
    var rows = [];
    return {
      name: name, rows: rows,
      getLastRow: function () { return rows.length; },
      getRange: function (r, c, nr, nc) {
        if (typeof r === 'string') return { setNumberFormat: function () {} };
        return {
          getValues: function () {
            var out = [];
            for (var i = 0; i < nr; i++) {
              var row = rows[r - 1 + i] || [];
              out.push(row.slice(c - 1, c - 1 + nc));
            }
            return out;
          },
          setValues: function (v) {
            for (var i = 0; i < v.length; i++) {
              for (var j = 0; j < v[i].length; j++) rows[r - 1 + i][c - 1 + j] = v[i][j];
            }
          },
          setNumberFormat: function () {}
        };
      },
      appendRow: function (row) {
        if (env.failAppends > 0 && name === env.failOnTab) {
          env.failAppends--;
          throw new Error('Service Spreadsheets timed out while accessing document');
        }
        rows.push(row);
      },
      setFrozenRows: function () {},
      getDataRange: function () { return { getValues: function () { return rows.slice(); } }; }
    };
  }
  env.makeTab = makeTab;

  var g = options.global || global;
  g.SpreadsheetApp = { getActiveSpreadsheet: function () { return {
    getSheetByName: function (n) { return env.tabs[n] || null; },
    insertSheet: function (n) { env.tabs[n] = makeTab(n); return env.tabs[n]; },
    getSpreadsheetTimeZone: function () { env.tzCalls++; return 'America/Chicago'; }
  }; } };

  g.PropertiesService = { getScriptProperties: function () { return {
    getProperty: function (k) { env.propGets++; return k in env.props ? env.props[k] : null; },
    setProperty: function (k, v) { env.props[k] = v; },
    deleteProperty: function (k) { delete env.props[k]; }
  }; } };

  g.CacheService = { getScriptCache: function () { return {
    get: function (k) { return k in env.cache ? env.cache[k] : null; },
    put: function (k, v) { env.cache[k] = v; },
    remove: function (k) { delete env.cache[k]; }
  }; } };

  g.LockService = { getScriptLock: function () { return {
    tryLock: function () {
      if (env.locked) { env.lockDenials++; return false; }
      env.locked = true; return true;
    },
    releaseLock: function () { env.locked = false; }
  }; } };

  function pad(n) { return String(n).padStart(2, '0'); }
  g.Utilities = {
    formatDate: function (d, tz, fmt) {
      var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      if (fmt.indexOf('HH') < 0) return day;
      return day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
    // Not real HMAC. It only has to be stable and depend on its input.
    computeHmacSha256Signature: function (msg, key) {
      var out = [], s = String(msg) + '|' + String(key);
      for (var i = 0; i < 32; i++) {
        var acc = i * 31;
        for (var j = 0; j < s.length; j++) acc = (acc * 33 + s.charCodeAt(j)) & 0xffff;
        out.push(acc & 0xff);
      }
      return out;
    },
    getUuid: function () { return 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; },
    sleep: function (ms) { env.slept += ms; }
  };

  g.Logger = { log: function () {} };
  g.ContentService = { MimeType: { JSON: 'json', CSV: 'csv' }, createTextOutput: function (t) {
    return { setMimeType: function () { return this; }, getContent: function () { return t; } };
  } };

  return env;
}

module.exports = { makeEnv: makeEnv };
