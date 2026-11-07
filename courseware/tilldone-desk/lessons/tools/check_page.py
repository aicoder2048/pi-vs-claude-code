"""Load lesson pages in real Chrome, report JS errors / missing glossary terms / broken links, save screenshots.

Usage (from LESSONS/):
  uv run --no-project --with playwright python tools/check_page.py L01-xxx.html [more.html ...] [--shots DIR] [--theme light|dark|ink] [--width N] [--mobile]
--theme forces the course theme via localStorage (prefix read from tools/sources.json or assets/course-config.js).
Exit code 1 if any page has errors.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def course_prefix() -> str:
    """localStorage 键前缀：先看 tools/sources.json，没有就从 assets/course-config.js 里读。"""
    try:
        return json.loads((ROOT / "tools" / "sources.json").read_text(encoding="utf-8"))["course"]["prefix"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    m = re.search(r'prefix:\s*"([^"]+)"', (ROOT / "assets" / "course-config.js").read_text(encoding="utf-8"))
    if not m:
        sys.exit("找不到课程前缀：tools/sources.json 或 assets/course-config.js 里要有 prefix")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pages", nargs="+")
    ap.add_argument("--shots", default=None, help="directory for full-page screenshots")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--mobile", action="store_true")
    ap.add_argument("--theme", choices=["light", "dark", "ink"], help="force a theme via localStorage")
    ap.add_argument("--width", type=int, default=1300)
    a = ap.parse_args()

    bad = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        vp = {"width": 390, "height": 900} if a.mobile else {"width": a.width, "height": 900}
        ctx = browser.new_context(viewport=vp, color_scheme="dark" if a.dark else "light")
        if a.theme:
            ctx.add_init_script(f"try{{localStorage.setItem('{course_prefix()}-theme','{a.theme}')}}catch(e){{}}")
        for name in a.pages:
            path = (ROOT / name).resolve()
            page = ctx.new_page()
            errors, warns = [], []
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: (errors if m.type == "error" else warns).append(f"{m.type}: {m.text}")
                    if m.type in ("error", "warning") else None)
            page.goto(path.as_uri())
            page.wait_for_timeout(1500)
            # broken local links
            hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.getAttribute('href'))")
            for h in hrefs:
                if re.match(r"^(https?:|mailto:|#)", h):
                    continue
                f = h.split("#")[0]
                if f and not (path.parent / f).exists():
                    errors.append(f"broken link: {h}")
            # in-page anchors
            for h in hrefs:
                if h.startswith("#") and len(h) > 1 and page.query_selector(f"[id='{h[1:]}']") is None:
                    errors.append(f"missing anchor: {h}")
            missing = page.eval_on_selector_all("a.term-missing", "els => els.map(e => e.getAttribute('href'))")
            for m in missing:
                errors.append(f"glossary term missing: {m}")
            charts = page.eval_on_selector_all(".demo", "els => els.map(e => [e.id, e.children.length + e.textContent.trim().length, e.clientHeight])")
            for c in charts:
                if c[1] == 0:
                    errors.append(f"demo did not render: #{c[0]}")
            # 数据驱动课程的行情图（.chart 里由图表库画出 canvas）
            for cid, ok in page.eval_on_selector_all(".chart", "els => els.map(e => [e.id, !!e.querySelector('canvas')])"):
                if not ok:
                    errors.append(f"chart did not render: #{cid}")
            imgs = page.eval_on_selector_all("main img", "els => els.map(e => [e.getAttribute('src'), e.naturalWidth])")
            for src, w in imgs:
                if not w:
                    errors.append(f"image did not load: {src}")
            hscroll = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2")
            if hscroll:
                errors.append("horizontal page scroll")
            if a.shots:
                out = Path(a.shots)
                out.mkdir(parents=True, exist_ok=True)
                suffix = ("-dark" if a.dark else "") + (f"-{a.theme}" if a.theme else "") + ("-mobile" if a.mobile else "") + (f"-w{a.width}" if a.width != 1300 else "")
                page.screenshot(path=str(out / f"{path.stem}{suffix}.png"), full_page=True)
            status = "OK " if not errors else "ERR"
            print(f"[{status}] {name}: {len(charts)} demos, {len(imgs)} images, {len(errors)} errors, {len(warns)} warnings")
            for e in errors + warns:
                print("   ", e)
            bad += bool(errors)
            page.close()
        browser.close()
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
