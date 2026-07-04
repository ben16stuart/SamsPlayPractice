"""Sam's Play Practice — Flask app.

Serves the rehearsal interface and does the script analysis server-side:
POST /api/parse takes raw script text and returns structured items
(dialogue / song cues / stage directions), the detected cast, and songs.

Parsing is done by Claude (structured outputs) when an Anthropic API key is
configured; otherwise a heuristic pattern parser handles standard script
formats. Set ANTHROPIC_API_KEY to enable AI parsing.
"""

import base64
import io
import json
import os
import re
import socket
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

try:
    import anthropic
except ImportError:  # AI parsing optional — heuristic parser still works
    anthropic = None

try:
    from yt_dlp import YoutubeDL
except ImportError:
    YoutubeDL = None

from pypdf import PdfReader

try:
    import pytesseract
    from PIL import Image

    # pytesseract needs the tesseract binary, not just the Python package
    pytesseract.get_tesseract_version()
    TESSERACT = True
except Exception:  # noqa: BLE001 — missing package or binary
    TESSERACT = False

app = Flask(__name__)

SONG_CUE = re.compile(
    r"^\s*[\[\(]?\s*(?:SONG|MUSIC|MUSICAL\s+NUMBER)\s*[:#-]\s*(.+?)\s*[\]\)]?\s*$", re.I
)
HEADING = re.compile(
    r"^\s*(?:ACT|SCENE|PROLOGUE|EPILOGUE|INTERMISSION|CURTAIN|THE\s+END|END\s+OF)\b", re.I
)
# "NAME: dialogue" — name is short, mostly uppercase, 1-4 words
INLINE_ROLE = re.compile(r"^\s*([A-Z][A-Za-z0-9'&.\- ]{0,30}?)\s*[:：]\s*(.*)$")
# "NAME" alone on a line, optionally with a parenthetical: "SAM (nervous)"
ALONE_ROLE = re.compile(r"^([A-Z][A-Z0-9'&.\- ]{0,30}?)(\s*\([^)]*\))?\s*$")
WRAPPED = re.compile(r"^[\(\[].*[\)\]]$")
PARENTHETICAL = re.compile(r"[\(\[][^\)\]]*[\)\]]")

NOT_ROLES = {
    "INT", "EXT", "FADE IN", "FADE OUT", "CUT TO", "NOTE", "TIME", "SETTING",
    "AT RISE", "LIGHTS", "SOUND", "SFX", "TITLE", "CAST", "CHARACTERS",
}


def looks_like_role_name(name: str) -> bool:
    clean = name.strip().rstrip(".")
    if not clean or len(clean) > 32:
        return False
    if clean.upper() in NOT_ROLES:
        return False
    if HEADING.match(clean):
        return False
    if len(clean.split()) > 4:
        return False
    letters = re.sub(r"[^A-Za-z]", "", clean)
    if not letters:
        return False
    upper = re.sub(r"[^A-Z]", "", clean)
    if len(upper) / len(letters) >= 0.8:
        return True
    return bool(re.fullmatch(r"[A-Z][a-z]+", clean))  # "Sam:" style


def normalize_role(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().rstrip(".")).upper()


def parse_script(raw: str) -> list[dict]:
    """Parse pasted script text into a list of items:
    {type: 'dialogue', role, display, speak} | {type: 'song', title} |
    {type: 'direction', text}
    """
    items: list[dict] = []
    current: dict | None = None

    def flush():
        nonlocal current
        if current and current["text"].strip():
            current["text"] = re.sub(r"\s+", " ", current["text"].strip())
            items.append(current)
        current = None

    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            continue

        song = SONG_CUE.match(line)
        if song:
            flush()
            items.append({"type": "song", "title": song.group(1).strip()})
            continue

        if WRAPPED.match(line):
            flush()
            items.append({"type": "direction", "text": line.strip("()[] ")})
            continue

        if HEADING.match(line) and not INLINE_ROLE.match(line):
            flush()
            items.append({"type": "direction", "text": line})
            continue

        inline = INLINE_ROLE.match(line)
        if inline and looks_like_role_name(inline.group(1)):
            flush()
            current = {
                "type": "dialogue",
                "role": normalize_role(inline.group(1)),
                "text": inline.group(2) or "",
            }
            continue

        alone = ALONE_ROLE.match(line)
        if alone and looks_like_role_name(alone.group(1)):
            flush()
            current = {"type": "dialogue", "role": normalize_role(alone.group(1)), "text": ""}
            continue

        if current is not None:
            current["text"] += (" " if current["text"] else "") + line
        else:
            items.append({"type": "direction", "text": line})

    flush()

    # Keep parentheticals for display, strip them from the spoken text
    for it in items:
        if it["type"] == "dialogue":
            it["display"] = it["text"]
            it["speak"] = re.sub(r"\s+", " ", PARENTHETICAL.sub(" ", it["text"])).strip()
            del it["text"]
    return items


# ---------------------------------------------------------------------------
# AI parsing (Claude with structured outputs)
# ---------------------------------------------------------------------------

PARSER_MODEL = os.environ.get("CLAUDE_PARSER_MODEL", "claude-opus-4-8")

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["dialogue", "song", "direction"]},
                    "role": {
                        "type": "string",
                        "description": "Character name in UPPERCASE for dialogue items; empty string otherwise",
                    },
                    "text": {
                        "type": "string",
                        "description": "Verbatim dialogue or stage-direction text; empty string for songs",
                    },
                    "title": {
                        "type": "string",
                        "description": "Song title for song items; empty string otherwise",
                    },
                },
                "required": ["type", "role", "text", "title"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

PARSE_SYSTEM = """\
You extract the structure of theater/musical scripts so an app can read them aloud.

Given a script in any format (colon-style "NAME: line", name-on-its-own-line, screenplay \
style, inconsistent capitalization, OCR'd text, etc.), return every element in order as items:

- "dialogue": one item per speech. "role" is the character name, normalized to UPPERCASE and \
consistent across the script (e.g. "Mrs Banks", "MRS. BANKS", and "Mrs. Banks (crying)" are \
all the role "MRS. BANKS"). Group speeches like "ALL" or "SAM & DOROTHY" keep that combined \
name as the role. "text" is the spoken line verbatim, including inline (parentheticals).
- "song": a musical number cue. "title" is the song title. If lyrics follow a song cue and \
are clearly part of the number, you may omit them or keep them as dialogue sung by the \
named character(s) — prefer keeping character-attributed sung lines as dialogue.
- "direction": stage directions, scene headings (ACT I, SCENE 2), and any other non-spoken text.

Do not invent, merge, reorder, paraphrase, or drop lines. Preserve the original wording exactly."""


def ai_available() -> bool:
    return anthropic is not None and bool(
        os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    )


def ai_parse_script(raw: str) -> list[dict]:
    """Parse the script with Claude. Returns items in the same shape as
    parse_script(). Raises on any API/parsing failure (caller falls back)."""
    client = anthropic.Anthropic()
    # Stream so long scripts (large JSON responses) don't hit HTTP timeouts.
    with client.messages.stream(
        model=PARSER_MODEL,
        max_tokens=64000,
        thinking={"type": "adaptive"},
        system=PARSE_SYSTEM,
        output_config={"format": {"type": "json_schema", "schema": PARSE_SCHEMA}},
        messages=[{"role": "user", "content": raw}],
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("the model declined to process this text")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("script too long for a single AI parse")

    text = next(b.text for b in response.content if b.type == "text")
    items = []
    for it in json.loads(text)["items"]:
        if it["type"] == "dialogue" and it["role"].strip() and it["text"].strip():
            display = re.sub(r"\s+", " ", it["text"].strip())
            items.append({
                "type": "dialogue",
                "role": normalize_role(it["role"]),
                "display": display,
                "speak": re.sub(r"\s+", " ", PARENTHETICAL.sub(" ", display)).strip(),
            })
        elif it["type"] == "song" and it["title"].strip():
            items.append({"type": "song", "title": it["title"].strip()})
        elif it["type"] == "direction" and it["text"].strip():
            items.append({"type": "direction", "text": it["text"].strip()})
    if not items:
        raise RuntimeError("AI returned no script items")
    return items


TRANSCRIBE_SYSTEM = """\
You transcribe photographed or scanned pages of a theater/musical script.

Output ONLY the transcription — no commentary, no markdown fences. Reproduce the text \
faithfully: keep character names exactly as printed (e.g. "SAM:"), keep stage directions \
in their (parentheses) or [brackets], keep song cues, and put each speech on its own line \
with a blank line between elements. If a word is genuinely illegible, write [illegible]. \
Transcribe the pages in the order given."""


def ai_transcribe(blocks: list[dict]) -> str:
    """Have Claude transcribe image/PDF content blocks into plain script text."""
    client = anthropic.Anthropic()
    with client.messages.stream(
        model=PARSER_MODEL,
        max_tokens=64000,
        thinking={"type": "adaptive"},
        system=TRANSCRIBE_SYSTEM,
        messages=[{"role": "user", "content": blocks}],
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal":
        raise RuntimeError("the model declined to process this file")
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not text:
        raise RuntimeError("no text recognized")
    return text


# ---------------------------------------------------------------------------
# Music library — persistent, one folder per play under media/
# ---------------------------------------------------------------------------

MEDIA_DIR = Path(__file__).resolve().parent / "media"


def slugify(name: str) -> str:
    """Filesystem-safe name, identical to the client-side slug() in app.js."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "untitled"


def play_dir(play: str) -> Path:
    d = MEDIA_DIR / slugify(play)
    d.mkdir(parents=True, exist_ok=True)
    return d


def song_entry(play_slug: str, f: Path) -> dict:
    return {"stem": f.stem, "url": f"/media/{play_slug}/{f.name}"}


@app.get("/media/<play>/<name>")
def media(play: str, name: str):
    # Only serve names we could have written ourselves
    if slugify(play) != play or secure_filename(name) != name:
        return jsonify({"error": "not found"}), 404
    return send_from_directory(MEDIA_DIR / play, name)


@app.get("/api/songs")
def api_songs():
    """List the saved songs for a play so the UI can re-attach them."""
    play = slugify(request.args.get("play", ""))
    d = MEDIA_DIR / play
    if not d.is_dir():
        return jsonify({"songs": []})
    return jsonify({"songs": [song_entry(play, f) for f in sorted(d.iterdir()) if f.is_file()]})


@app.post("/api/upload_song")
def api_upload_song():
    """Save an uploaded audio file into the play's folder (persistent)."""
    file = request.files.get("audio")
    play = request.form.get("play", "")
    title = request.form.get("title", "")
    if file is None or not title.strip():
        return jsonify({"error": "audio file and title required"}), 400
    ext = Path(secure_filename(file.filename or "")).suffix or ".mp3"
    d = play_dir(play)
    stem = slugify(title)
    for old in d.glob(f"{stem}.*"):
        old.unlink()
    dest = d / f"{stem}{ext}"
    file.save(dest)
    return jsonify(song_entry(d.name, dest))


@app.post("/api/download_song")
def api_download_song():
    """Download a YouTube (or other yt-dlp-supported) link's audio into the
    play's folder. Keeps the native audio container so ffmpeg isn't needed."""
    if YoutubeDL is None:
        return jsonify({"error": "yt-dlp is not installed (pip install yt-dlp)"}), 501
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    play = data.get("play", "")
    title = (data.get("title") or "").strip()
    if not url or not title:
        return jsonify({"error": "url and title required"}), 400

    d = play_dir(play)
    stem = slugify(title)
    for old in d.glob(f"{stem}.*"):
        old.unlink()
    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(d / f"{stem}.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            dest = Path(ydl.prepare_filename(info))
    except Exception as e:  # noqa: BLE001 — geo-blocks, bad URLs, age gates…
        return jsonify({"error": f"download failed: {e}"}), 422
    if not dest.exists():
        return jsonify({"error": "download produced no file"}), 422
    return jsonify(song_entry(d.name, dest))


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/extract_image")
def api_extract_image():
    """OCR photographed script pages. Uses Claude vision when a key is set
    (robust to phone-photo skew/lighting), otherwise local Tesseract OCR."""
    files = request.files.getlist("images")
    if not files:
        return jsonify({"error": "no images uploaded"}), 400

    allowed = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    images = []  # (mimetype, bytes)
    for f in files:
        mime = f.mimetype or ""
        if mime not in allowed:
            return jsonify({
                "error": f"unsupported image type '{mime}' ({f.filename}). "
                         "Use JPEG or PNG — iPhone users: set camera format to "
                         "'Most Compatible', or share the photo as JPEG."
            }), 415
        images.append((mime, f.read()))

    if ai_available():
        try:
            blocks = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime,
                        "data": base64.standard_b64encode(data).decode(),
                    },
                }
                for mime, data in images
            ]
            return jsonify({"text": ai_transcribe(blocks), "method": "ai-vision"})
        except Exception:  # noqa: BLE001 — fall through to Tesseract
            pass

    if TESSERACT:
        pages = []
        for _, data in images:
            try:
                pages.append(pytesseract.image_to_string(Image.open(io.BytesIO(data))))
            except Exception as e:  # noqa: BLE001
                return jsonify({"error": f"OCR failed: {e}"}), 422
        text = "\n\n".join(p.strip() for p in pages if p.strip())
        if len(text) < 40:
            return jsonify({
                "error": "OCR found almost no text. Try a sharper, straight-on, "
                         "well-lit photo — or set ANTHROPIC_API_KEY for AI vision, "
                         "which handles difficult photos much better."
            }), 422
        return jsonify({"text": text, "method": "tesseract"})

    return jsonify({
        "error": "No OCR engine available. Install Tesseract "
                 "(e.g. 'sudo apt install tesseract-ocr' or 'brew install tesseract') "
                 "for free local OCR, or set ANTHROPIC_API_KEY for AI vision."
    }), 501


@app.post("/api/extract_pdf")
def api_extract_pdf():
    """Extract the text layer of an uploaded PDF — no AI involved.
    Scanned/image-only PDFs have no text layer and are reported as such."""
    file = request.files.get("pdf")
    if file is None:
        return jsonify({"error": "no file uploaded"}), 400
    raw = file.read()
    try:
        reader = PdfReader(io.BytesIO(raw))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as e:  # noqa: BLE001 — encrypted/corrupt PDFs etc.
        return jsonify({"error": f"could not read PDF: {e}"}), 400

    text = "\n\n".join(p.strip() for p in pages if p.strip())
    # A script page has hundreds of characters; near-empty output means the
    # PDF is a scan (images of pages) with no embedded text.
    if len(text) >= 40 * max(1, len(pages)):
        return jsonify({"text": text, "pages": len(pages), "method": "text-layer"})

    # Scanned PDF — Claude's PDF support runs vision on each page.
    if ai_available():
        try:
            blocks = [{
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.standard_b64encode(raw).decode(),
                },
            }]
            return jsonify({
                "text": ai_transcribe(blocks),
                "pages": len(pages),
                "method": "ai-vision",
            })
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": f"This PDF is a scan and AI transcription failed ({e})."}), 422

    return jsonify({
        "error": "This PDF appears to be a scan (no embedded text). "
                 "Set ANTHROPIC_API_KEY to transcribe it with AI vision, run OCR on it "
                 "first (e.g. ocrmypdf), or take photos of the pages and use "
                 "'Load from photos' instead."
    }), 422


@app.post("/api/parse")
def api_parse():
    data = request.get_json(silent=True) or {}
    text = data.get("script", "")
    use_ai = data.get("use_ai", True)

    parser = "heuristic"
    note = ""
    items = None
    if use_ai and ai_available():
        try:
            items = ai_parse_script(text)
            parser = "ai"
        except Exception as e:  # noqa: BLE001 — any AI failure falls back
            note = f"AI parse failed ({e}); used the pattern parser instead."
    elif use_ai:
        note = "Set ANTHROPIC_API_KEY to enable AI parsing; used the pattern parser."
    if items is None:
        items = parse_script(text)

    counts: dict[str, int] = {}
    for it in items:
        if it["type"] == "dialogue":
            counts[it["role"]] = counts.get(it["role"], 0) + 1
    roles = sorted(
        ({"name": n, "count": c} for n, c in counts.items()),
        key=lambda r: -r["count"],
    )
    songs = list(dict.fromkeys(it["title"] for it in items if it["type"] == "song"))

    return jsonify(
        {"items": items, "roles": roles, "songs": songs, "parser": parser, "note": note}
    )


def pick_port() -> int:
    """Prefer $PORT or 5000, but skip past ports already in use —
    on macOS, AirPlay Receiver squats on 5000."""
    start = int(os.environ.get("PORT", "5000"))
    for port in range(start, start + 10):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                print(f"Port {port} is busy (on macOS this is usually AirPlay Receiver) — trying {port + 1}")
                continue
        return port
    raise SystemExit(f"No free port found between {start} and {start + 9}")


if __name__ == "__main__":
    port = pick_port()
    print(f"\n  🎭 Sam's Play Practice → http://localhost:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=False)
