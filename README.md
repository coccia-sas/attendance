# Class attendance

A replacement for Poll Everywhere. Three static pages on GitHub Pages, one Google
Apps Script behind them, and a Google Sheet that holds the data.

No location services. No accounts for students. No cost.

## How it works in class

1. You open `display.html` on the projector. It shows a QR code, the check-in URL,
   and a six digit code that changes every 60 seconds.
2. You press **Open check-in**.
3. Students scan the QR once, type their student ID and the code on the screen,
   and press the button. Their phone remembers the ID, so after the first class
   it is one field.
4. The backend checks three things: the session is open, the code is current, and
   the ID is on your roster. It refuses a second check-in from the same ID on the
   same day.
5. You press **Close check-in**. Attendance sits in the Sheet, one row per student
   per day.

One deployment serves every class you teach. A **class id** such as `FINA3000-02`
identifies one course-section. It appears in the QR link, in the Roster tab, and
in the Attendance tab. Add a class by adding an entry to `docs/config.js` and
rerunning `tools/make_qr.py`.

### During add and drop

A student who registered yesterday is not on your roster yet. Turning that student
away at the door is the wrong outcome, so `ALLOW_UNROSTERED` in `Code.gs` is
`true`. Such a check-in is still recorded, with Status `pending`, and the student
is told to see you after class. `admin.html` lists the pending IDs.

When you repaste the roster and press **Reload roster**, every pending row for a
student who now appears on the roster gets their name filled in and flips to
`enrolled`. Nobody loses a day.

Set `ALLOW_UNROSTERED` to `false` once the roster settles, which for Fall 2026 is
after September 4. An unknown ID is then refused outright.

A texted code dies in about a minute, which is the same protection Poll Everywhere
gives you. The page also records a random per-browser id, so you can spot one phone
checking in four students. It does not block that, it only records it.

## Files

| Path | What it is |
| --- | --- |
| `docs/index.html` | Student check-in page |
| `docs/display.html` | Projector view, plus Open and Close buttons |
| `docs/admin.html` | Today's present/absent list and CSV export |
| `docs/config.js` | The one file you edit. Holds the API URL. No secrets. |
| `docs/qr-<classid>.svg` | One QR code per class, generated once |
| `apps-script/Code.gs` | The backend |
| `tools/make_roster.py` | Class rolls (.csv or .xlsx) to the Roster tab |
| `tools/make_qr.py` | Regenerates the QR codes for your URL |

## Setup, once

### 1. Create the Sheet and the script

1. Sign in with your **olemiss** Google account. Student IDs should live in
   university Workspace, not a personal Drive.
2. Make a new Google Sheet. Name it `FIN 331 Attendance`.
3. In the Sheet: **Extensions > Apps Script**.
4. Delete the starter code. Paste in all of `apps-script/Code.gs`. Save.
5. In the editor, pick the `setup` function and press **Run**. Approve the
   permission prompt. It creates the three tabs and generates your keys.
6. Open **View > Logs**. Copy the `INSTRUCTOR_KEY` it prints. That is the key you
   type into the display and admin pages.

### 2. Deploy the web app

1. **Deploy > New deployment**, type **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Deploy, then copy the `/exec` URL.

"Anyone" sounds alarming and is not. The script only accepts the five actions in
`Code.gs`. Everything except check-in needs your instructor key, and the secret
that generates the codes never leaves the script.

### 3. Load the roster

Give it one `CLASS_ID=file` pair per class. It reads Blackboard grade centre
exports (.csv) and SAP class rolls (.xlsx).

```bash
python tools/make_roster.py "FINA3000-02=../00_FIN331_FALL2026/SEC2/grades/FINA3000SEC2.csv" "FINA3000-07=../00_FIN331_FALL2026/SEC7/Grades/FINA3000SEC7.csv"
```

That writes `tools/roster.csv` with the columns `Class, StudentID, Name, Email`.
Open it, copy every row under the header, and paste into the **Roster** tab.

The `M` prefix on a Blackboard student ID is stripped. The check-in page strips it
too, so a student may type the ID either way. Blackboard gives a WebID rather than
an address, so the email column is built as `<webid>@go.olemiss.edu`.

After any add or drop, repaste and press **Reload roster** on `admin.html`. That
also fixes any pending rows.

`roster.csv` holds student names and IDs. It is gitignored. Do not commit it.

### 4. Publish the pages

```bash
gh repo create attendance --public --source=. --remote=origin
```

Then in the repo: **Settings > Pages > Source: main branch, /docs folder**.

Your URL will look like `https://coccia-sas.github.io/attendance/`.

### 5. Point the pages at the script, and redraw the QR codes

1. Open `docs/config.js`. Replace `PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE` with the
   `/exec` URL.
2. Regenerate the QR codes so they point at your real Pages URL:

```bash
python tools/make_qr.py https://coccia-sas.github.io/attendance/
```

3. Commit and push. Pages redeploys in about a minute.

### 6. Bookmark two links on the classroom laptop

- `.../display.html` for the projector
- `.../admin.html` for your own screen

Type the instructor key into each one once. It stays in that browser.

## Day to day

- **Start of class:** open `display.html`, press Open check-in.
- **End of the window:** press Close check-in.
- **Grading:** open the Sheet, or press Download all CSV on `admin.html`.

The control strip on `display.html` fades out so it does not distract on the
projector. Move the mouse to the top of the screen to bring it back.

## Things worth knowing

- **The code window is 60 seconds, and the previous code is still accepted.** So a
  code is usable for 60 to 120 seconds. Change `WINDOW_SECONDS` in `Code.gs` if
  you want it tighter or looser.
- **A student with no phone** can give you the ID at the desk and you add the row
  to the Sheet yourself.
- **If the campus wifi dies,** nothing works. Keep a paper sign-in sheet in your
  bag for that day.
- **Apps Script quotas** are far above one course. A 60 student section checking in
  twice a week is nothing.
- **The Sheet is the record.** The pages are only a view of it.

## If something breaks

| Symptom | Cause |
| --- | --- |
| Display says `Bad instructor key.` | Wrong key in the field. Retype it. |
| Display says `offline` | `apiUrl` in `config.js` is wrong, or you have no network. |
| Student sees `not on my roster yet` | Normal during add and drop. The row is saved as pending. Repaste the roster, press Reload roster. |
| Student sees `code is wrong or expired` | They typed an old code, or their phone clock is far off. |
| Everyone sees `Check-in is closed` | You did not press Open check-in, or the class picker is on the wrong class. |
| The QR on screen is missing | No `qr-<classid>.svg` for that class. Rerun `make_qr.py`. |
