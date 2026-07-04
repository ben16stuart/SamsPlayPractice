# 🎭 Sam's Play Practice

A locally-hosted Flask web app to help Sam memorize his lines for the musical.
Paste the script and the app automatically finds every character, gives each
one their own voice, reads everyone **else's** lines aloud, plays the show's
songs at the right moments, and leaves Sam's lines for him to say — all in a
theater-style teleprompter that scrolls through the script as the cast performs.

Everything runs on your own computer — no accounts, no uploads, no cloud.

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

Then open **http://localhost:5000** in Chrome or Edge (best voice support).

## How to use it

1. **Paste the script** and click **✨ Analyze script & find roles**.
   The Flask backend parses the common script formats:
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
4. **Attach the songs.** Each detected song cue gets a file slot — attach the
   mp3/m4a rehearsal track and it plays at that point in the script. With no
   file attached, the narrator announces the song instead.
5. **Rehearse.** Press Play — the teleprompter scrolls through the script,
   spotlighting the current line, with Sam's lines highlighted in gold. Click
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
  structured JSON.
- **`static/app.js`** — the teleprompter, playback engine, and both TTS engines.
  Speech and song audio never leave the browser.
- **`templates/index.html`**, **`static/styles.css`** — the marquee-and-spotlight UI.

## Notes

- Chrome/Edge recommended. Firefox and Safari work with Browser voices; Kokoro needs a modern browser.
- Kokoro's model downloads from Hugging Face on first use and is cached by the browser afterward.
- Role detection is heuristic and runs locally (no API key needed). If a role is missed, make sure the character's name is in CAPS followed by a colon or on its own line.
