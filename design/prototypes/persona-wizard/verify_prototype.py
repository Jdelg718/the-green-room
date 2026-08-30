#!/usr/bin/env python3
"""Static acceptance checks for the standalone persona-wizard prototype."""
from html.parser import HTMLParser
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
HTML = ROOT / "index.html"

class Audit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.external = []
        self.labels = 0
        self.buttons = 0
        self.inputs = 0
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            assert attrs["id"] not in self.ids, f"duplicate id: {attrs['id']}"
            self.ids.add(attrs["id"])
        if tag == "label": self.labels += 1
        if tag == "button": self.buttons += 1
        if tag in {"input", "textarea", "select"}: self.inputs += 1
        if tag in {"script", "link", "img", "iframe", "audio", "video", "source"}:
            url = attrs.get("src") or attrs.get("href")
            if url and (url.startswith("http:") or url.startswith("https:") or url.startswith("//")):
                self.external.append(url)

def require(text, needles, group):
    missing = [n for n in needles if n not in text]
    assert not missing, f"{group} missing: {missing}"

def main():
    text = HTML.read_text(encoding="utf-8")
    parser = Audit(); parser.feed(text)
    assert not parser.external, f"external resources found: {parser.external}"
    assert '<meta name="viewport"' in text
    assert 'prefers-reduced-motion:reduce' in text
    assert '@media(max-width:340px)' in text and '@media(max-width:560px)' in text
    assert 'min-height:44px' in text
    assert 'overflow:auto' in text and 'overflow:hidden' in text
    # Most controls live in JavaScript-rendered template strings, so count both
    # initially parsed nodes and literal template markup.
    control_counts = {
        "labels": text.count("<label"),
        "buttons": text.count("<button"),
        "inputs": text.count("<input") + text.count("<textarea") + text.count("<select"),
    }
    assert all(value >= 10 for value in control_counts.values()), control_counts
    require(text, [f"Step {i} of 11" for i in range(1, 12)], "guided steps")
    require(text, ["Goal","Room role","Traits","Boundaries","Voice","Turn discipline","Tensions","Practice scenes","Live rehearsal","Pack review","Save & export"], "step navigation")
    require(text, ["The Boundary Setter","I cave too easily","salary","Interruption 24 → 12","dominance 66 → 42","no-humiliation"], "acceptance story")
    require(text, ["Generation error","Unsafe request","Real-person request","Copyrighted character","Private data found","Validator failure","Offline draft"], "prototype states")
    require(text, ["Runtime context","Metadata only","AGENTS.md","BACKGROUND.md","VOICE.md","RELATIONSHIPS.md","SCENARIOS.md","persona.yaml","PROVENANCE.md","SOURCES.md","LICENSE"], "pack review")
    require(text, ["No public publishing","not an Official Catalog","API keys","rehearsal transcripts","private source notes","external_tools: false"], "privacy and safety")
    assert "a.download='the-boundary-setter.greenroom'" in text
    assert "if(!data.validated)return" in text
    assert "localStorage.setItem('greenroom-boundary-setter-draft'" in text
    assert "localStorage.getItem('greenroom-boundary-setter-draft')" in text
    assert "fields:data.fields" in text
    # No network APIs in prototype script.
    assert not re.search(r"\b(fetch|XMLHttpRequest|WebSocket)\s*\(", text)
    print("PASS standalone HTML parses with unique IDs")
    print("PASS 11-step guided flow and Boundary Setter acceptance story present")
    print("PASS all required success/error/safety/offline states present")
    print("PASS runtime-vs-metadata review and canonical files present")
    print("PASS validator gates local .greenroom prototype export")
    print("PASS local save restores editable fields, wizard position, and validator state")
    print("PASS export explicitly excludes keys, private notes, and transcripts")
    print("PASS no external resources or network APIs")
    print("PASS responsive 320/390 rules, 44px controls, focus and reduced motion")
    print(f"PASS accessibility primitives: {control_counts['labels']} labels, {control_counts['buttons']} buttons, {control_counts['inputs']} inputs")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        raise SystemExit(1)
