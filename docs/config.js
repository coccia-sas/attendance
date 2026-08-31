// Edit this file after you deploy the Apps Script web app.
// Nothing secret goes in this file. It is public on GitHub Pages.
window.ATTENDANCE_CONFIG = {
  // Example: https://script.google.com/macros/s/AKfy.../exec
  apiUrl: 'https://script.google.com/macros/s/AKfycbxr7JVUSLd5ZI8j4CiesoB6NxR434AgXwGCq_yK03tgQJ1OM4bBsN6Uuc4RYiTkNa2x/exec',

  term: 'Fall 2026',

  // One entry per course-section you teach. The key is the class id. It appears
  // in the QR link, in the Roster tab, and in the Attendance tab, so keep it
  // stable once the term starts.
  //
  // After you add or remove a class here, rerun tools/make_qr.py.
  classes: {
    'FINA3000-02': {
      label: 'FINA 3000 Section 2',
      meets: '4:00-5:15 pm M/W, Lamar 326'
    },
    'FINA3000-07': {
      label: 'FINA 3000 Section 7',
      meets: '1:00-2:15 pm M/W, Conner 226'
    }
  }
};
