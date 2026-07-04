"""Sam's Play Practice — Flask app.

Serves the rehearsal interface and does the script analysis server-side:
POST /api/parse takes raw script text and returns structured items
(dialogue / song cues / stage directions), the detected cast, and songs.
"""

import re

from flask import Flask, jsonify, render_template, request

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


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/parse")
def api_parse():
    data = request.get_json(silent=True) or {}
    text = data.get("script", "")
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

    return jsonify({"items": items, "roles": roles, "songs": songs})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
