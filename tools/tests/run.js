// Runs every test. Use it after any change to Code.gs or index.html:
//
//   node tools/tests/run.js
//
// It needs nothing installed. Node only.
'use strict';
var passed = 0, failed = 0;

var t = {
  ok: function (label, cond, extra) {
    if (cond) {
      passed++;
      console.log('  PASS  ' + label);
    } else {
      failed++;
      console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : ''));
    }
  },
  eq: function (label, got, want) {
    this.ok(label, got === want,
            'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  }
};

(async function () {
  console.log('\nserver, apps-script/Code.gs');
  require('./server.test.js')(t);

  console.log('\nstudent page, docs/index.html');
  await require('./page.test.js')(t);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
