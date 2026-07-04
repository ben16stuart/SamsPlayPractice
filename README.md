# 🎭 Sam's Play Practice

A locally-hosted Flask web app to help Sam memorize his lines for the musical.
Paste the script and the app automatically finds every character, gives each
one their own voice, reads everyone **else's** lines aloud, plays the show's
songs at the right moments, and leaves Sam's lines for him to say — all in a
theater-style teleprompter that scrolls through the script as the cast performs.

Everything runs on your own computer — no accounts, no uploads, no cloud, and
**no AI required**. (An optional AI add-on can be enabled later — see the end
of this file.)

## Quick start

```bash
./start.sh
```

…or manually:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Then open the URL it prints — normally **http://localhost:5000** — in Chrome
or Edge (best voice support). If port 5000 is taken the app hops to the next
free port and prints that instead. Set `PORT` to choose one explicitly.

### Running on a Mac

Works out of the box — `./start.sh` needs only `python3`, which macOS offers
to install automatically (via the Xcode Command Line Tools) the first time you
run it. Mac-specific notes:

- **Port 5000:** macOS's AirPlay Receiver listens on port 5000, so the app
  will usually start on 5001 there (it tells you). To free 5000 instead:
  System Settings → General → AirDrop & Handoff → turn off AirPlay Receiver.
- **Voices:** macOS ships excellent system voices, and Safari works too
  (Chrome recommended). Add more voices in System Settings → Accessibility →
  Spoken Content → System Voice → Manage Voices.
- **Photo OCR:** `brew install tesseract`.

## How to use it

0. **Start or resume from the home screen.** The app opens on **Your shows**:
   every saved show appears as a card with its progress (lines, current
   position, songs, last saved) and a **▶ Resume** button that restores the
   whole session — script, cast, voices, settings, music, and the exact line
   you left off at. Or type a name and **➕ Start** a new show. Everything is
   autosaved per show under `media/` as you work; 🗑 deletes a show and its
   music.
1. **Get the script in.** Paste it, click **📄 Load from PDF** (text layer
   extracted locally with `pypdf`), or click **📷 Load from photos** for
   pictures of printed pages — OCR'd locally with Tesseract (`sudo apt
   install tesseract-ocr` / `brew install tesseract`). Then click
   **✨ Analyze script & find roles**. The parser handles the common script
   conventions:
   - `SAM: I can't believe it's opening night!`
   - Character name (ALL CAPS) on its own line, dialogue below it
   - Stage directions in `(parentheses)` or `[brackets]`
   - Song cues like `[SONG: Ease on Down the Road]`, `SONG: Title`, or `MUSIC: Title`
2. **Check the cast list.** Every detected role gets an auto-assigned, distinct
   voice — change any of them and hit 🔊 to preview.
3. **Pick "My role"** (defaults to SAM if a Sam is in the cast) and choose what
   happens on his lines:
   - **Pause & wait** — playback stops until he presses Space/Continue (best for real rehearsal)
   - **Timed gap** — pauses roughly as long as the line would take to say
   - **Beep** — a short cue tone, then a pause
   - **Read aloud** — his lines are spoken too (good while first learning)
   - **Skip** — jump straight past
4. **Attach the music.** Set the **Show name**, then for each cue either
   attach an audio file, **paste a YouTube link** (the audio is downloaded
   with `yt-dlp` and saved locally), or paste a direct audio URL. 🔊 tests it.
   Files and YouTube downloads are stored on this computer under
   `media/<show name>/<song>.<ext>` — **they persist**, and the next time you
   analyze a script with the same show name they re-attach automatically.
   Need music somewhere the script has no cue? Hover any line in the
   teleprompter and click **+🎵** to insert a cue there (✕ removes it). With
   no audio attached, the narrator announces the song instead. Only download
   music you have the rights to use for rehearsal.
5. **Rehearse.** Press Play — the teleprompter scrolls through the script,
   spotlighting the current line, with Sam's lines highlighted in red. Click
   any line to start from there. Turn on **Hide my lines** to blur them and
   test his memory (hover to peek).

## Text-to-speech options

The engine is switchable from a dropdown; both are wired in and both support a
different voice per character:

| Engine | Quality | Setup | Offline? |
|---|---|---|---|
| **Browser voices** (Web Speech API) — default | OK–good (depends on OS) | none — instant | yes |
| **Kokoro** (kokoro-js, runs in-browser) | very natural | one-time ~80 MB model download, then cached | yes, after first download |

**Recommendation:** start with Browser voices to get rehearsing immediately,
then switch to **Kokoro** for nicer, more distinct character voices — it was a
good suggestion. Kokoro runs entirely inside the browser (WebGPU when
available, WASM otherwise); on older machines each line takes a moment to
generate. It offers ~14 distinct English voices (US/UK, male/female), plenty
for a full cast.

Other options considered, if you ever want to go further:

- **Piper** — fast local TTS, but needs a separate server process; similar quality to Kokoro with more setup.
- **Coqui XTTS** — voice cloning (a character could sound like a specific person); heavy install, wants a GPU.
- **Cloud APIs** (OpenAI TTS, ElevenLabs, Google) — best quality, but paid, needs API keys and internet, and the script gets sent to a third party.

For a kid rehearsing at home, in-browser Kokoro is the sweet spot: natural
voices, free, private, zero install.

## How it's built

- **`app.py`** — Flask server. `GET /` serves the page; `POST /api/parse` runs
  the script analysis (role detection, song cues, stage directions) and returns
  structured JSON. Also hosts the per-show persistence: `/api/play` (GET/POST — the full
  session saved as `media/<show>/play.json`), `/api/plays` (saved-show list),
  the music library (`/api/download_song` via yt-dlp, `/api/upload_song`,
  `/api/songs`), and `/media/<show>/<file>` serving. One folder per show
  under `media/` (gitignored) holds everything.
- **`static/app.js`** — the teleprompter, playback engine, and both TTS engines.
  Speech and song audio never leave the browser.
- **`templates/index.html`**, **`static/styles.css`** — the marquee-and-spotlight UI.

## PDF scripts

**Load from PDF** works entirely without AI: `pypdf` reads the PDF's embedded
text layer locally and drops it into the script box for review before
analysis. This covers any digitally-created PDF (exported from Word, Google
Docs, a publisher's licensed script PDF, etc.).

The one case that can't be done without AI/OCR is a **scanned** PDF — photos
of paper pages contain no text, only images. The app detects this and tells
you; options there are running OCR on it first (e.g. Adobe's "Recognize Text",
or `ocrmypdf` locally), or pasting the text from another source.

## Notes

- Chrome/Edge recommended. Firefox and Safari work with Browser voices; Kokoro needs a modern browser.
- Kokoro's model downloads from Hugging Face on first use and is cached by the browser afterward.
- Role detection runs fully locally. If a role is missed, make sure the character's name is in CAPS followed by a colon or on its own line.

## Optional AI add-on (for later)

The code ships with a dormant AI upgrade that is **completely off by default**
— nothing is installed, no key is needed, and no data leaves the machine. If
the built-in parser or Tesseract ever struggles (very messy script layouts,
hard-to-read photos, scanned PDFs), enable it with:

```bash
.venv/bin/pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...   # get one at https://platform.claude.com
./start.sh
```

That's the whole switch — with a key present, Claude handles script analysis
(any format, character names normalized) and photo/scanned-PDF transcription,
and the page says when AI did the work. Remove the key to go back to fully
local. Only the script text/page images are sent to the API, only at analysis
time; speech and song audio never leave the browser either way. Parsing a full
script costs a few cents (`claude-opus-4-8` by default; override with
`CLAUDE_PARSER_MODEL`).
