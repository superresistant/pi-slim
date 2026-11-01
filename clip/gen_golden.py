#!/usr/bin/env python3
"""Write clip/rs/tests/golden.json: Python clipclean results the Rust port must reproduce."""
import json
import random
import runpy
import textwrap
from pathlib import Path

here = Path(__file__).resolve().parent
cc = runpy.run_path(str(here / "clipclean"), run_name="clipclean")
WORDS = ("the agent wrote a long reply about kitty sessions and clipboard cleaning while aa rendered "
         "markdown tables café naïve 東京 emoji 🙂 path/to/file.rs:42 0.49.2 e.g. x=1 --flag").split()


def paragraph(rng):
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(3, 60)))


def block(rng):
    kind = rng.random()
    if kind < 0.5:
        return [paragraph(rng)]
    if kind < 0.65:
        return [f"{rng.choice('-*•')} {paragraph(rng)}" for _ in range(rng.randint(1, 4))]
    if kind < 0.75:
        return [f"{n}. {paragraph(rng)}" for n in range(1, rng.randint(2, 4))]
    if kind < 0.82:
        return ["#" * rng.randint(1, 3) + " " + paragraph(rng)[:40]]
    if kind < 0.9:
        return ["```", *("    " + paragraph(rng)[:50] for _ in range(rng.randint(1, 3))), "```"]
    if kind < 0.95:
        return [f"│ {paragraph(rng)[:30]} │", f"> {paragraph(rng)}"]
    return [""]


def tui_copy(rng):
    width, margin = rng.randint(30, 160), rng.choice((0, 1, 2))
    rows = []
    for _ in range(rng.randint(1, 5)):
        for logical in block(rng):
            wrapped = textwrap.wrap(logical, width - 2 * margin, drop_whitespace=True) or [""]
            rows += [" " * margin + w for w in wrapped]
        rows.append("")
    pad = rng.random()
    out = []
    for row in rows:
        if pad < 0.7:
            row = row.ljust(width)
        elif pad < 0.85 and row:
            row = row.ljust(width) if rng.random() < 0.6 else row
        out.append(row)
    if rng.random() < 0.3 and out:
        out[-1] = out[-1].rstrip()
    return "\n".join(out[: rng.randint(1, len(out))] if rng.random() < 0.3 else out)


def plain(rng):
    return "\n".join(paragraph(rng) + ("  " if rng.random() < 0.2 else "") for _ in range(rng.randint(1, 6)))


fixed = [
    "", "x", "a\nb", "\n\n\n", "   \n   ", "\t\x1c\n\x1f ",
    " Done. kitty-paste is now project-owned with its runtime path symlinked; behavior and Kitty mappings are unchanged. Docs and HANDOFF now correctly distinguish synchronous Ctrl+V, asynchronous CLIPBOARD cleanup, and unsupported PRIMARY/middle-click         \n cleanup.",
    "A normal Markdown line ending in two spaces.  \nNext line",
    " Short line".ljust(80) + "\n continuation",
    " First line".ljust(80) + "\n" + " Second line".ljust(80),
    " " + "word " * 40 + "end     \n cleanup.",
    "١٢. arabic digits list".ljust(40) + "\n" + "٣. second".ljust(40) + "\n" + "next".ljust(40),
    "##### h5".ljust(30) + "\n" + "####### seven".ljust(30) + "\n" + "tail".ljust(30),
    "-x not bullet".ljust(30) + "\n" + "- bullet".ljust(30) + "\n" + "*\tbullet tab".ljust(30),
]
rng = random.Random(20261101)
texts = fixed + [tui_copy(rng) for _ in range(700)] + [plain(rng) for _ in range(150)]
cases = []
for text in texts:
    tui, width = cc["detect_tui_paste"](text)
    cases.append({"text": text, "tui": tui, "width": width,
                  "clean": cc["clean_tui_paste"](text, width), "cleaned": cc["cleaned"](text)})
out = here / "rs/tests/golden.json"
out.write_text(json.dumps(cases, ensure_ascii=False, indent=0) + "\n")
print(len(cases), "cases,", sum(c["tui"] for c in cases), "tui")
