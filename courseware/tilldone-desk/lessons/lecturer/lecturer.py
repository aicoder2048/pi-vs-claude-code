"""AI 讲师入口（课号 = 讲稿文件名，如 scripts/L02.json → L02）。

    uv run lecturer.py check [L02 ...] [--readouts]  讲稿自检（不用启动服务，不调用模型）
    uv run lecturer.py audio [L02 ...]               预合成讲师音频；不写课号 = 全部
    uv run lecturer.py run L02 [--from s3]           开讲，讲完自动进入下一课（需先启动课程服务）
"""

from __future__ import annotations

import argparse
import re
import asyncio
import json
import sys
from pathlib import Path

from script import Script, ScriptError, load_script
from tts import LECTURER_VOICE, synthesize

HERE = Path(__file__).parent
LESSONS = HERE.parent
SCRIPTS = HERE / "scripts"
FALLBACK_PORT = 8766


def default_port(manifest: Path = LESSONS / "tools" / "sources.json") -> int:
    """课程服务的端口：取 sources.json 里的 course.port，和 serve.py 的默认值一致。"""
    try:
        return int(json.loads(manifest.read_text(encoding="utf-8"))["course"]["port"])
    except (OSError, ValueError, KeyError, TypeError):
        return FALLBACK_PORT


def course_url(port: int, lessons_dir: str = LESSONS.name) -> str:
    if not 1 <= port <= 65535:
        raise SystemExit(f"端口号不合法：{port}")
    return f"http://127.0.0.1:{port}/{lessons_dir}/"


def script_path(lesson_id: str, scripts_dir: Path = SCRIPTS) -> Path:
    return scripts_dir / f"{lesson_id.upper()}.json"


COURSE_CONFIG = LESSONS / "assets" / "course-config.js"


def course_order(config: Path = COURSE_CONFIG) -> list[str]:
    """课程配置 CL.LESSONS 里的课号顺序（= 学习路线），大写。没有配置文件时为空。"""
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return []
    return [m.upper() for m in re.findall(r'\bid:\s*"([^"]+)"', text)]


def all_lessons(scripts_dir: Path = SCRIPTS, config: Path = COURSE_CONFIG) -> list[str]:
    """有讲稿的课：先按课程配置的学习路线排，配置里没有的按课号排在后面。"""
    have = {p.stem.upper() for p in scripts_dir.glob("*.json")}
    order = [i for i in course_order(config) if i in have]
    return order + sorted(have - set(order))


def lesson_sequence(first: str, scripts_dir: Path = SCRIPTS, config: Path = COURSE_CONFIG) -> list[str]:
    """从 first 开始、按学习路线排序的所有有讲稿的课。讲完一课自动进入下一课。"""
    first = first.upper()
    ids = all_lessons(scripts_dir, config)
    if first not in ids:
        raise ScriptError(f"没有 {first} 的讲稿（{scripts_dir}）")
    return ids[ids.index(first):]


def pick(lessons: list[str]) -> list[str]:
    ids = [x.upper() for x in lessons] or all_lessons()
    if not ids:
        raise ScriptError(f"{SCRIPTS} 里还没有讲稿")
    return ids


async def prepare_audio(lesson_id: str, script: Script) -> None:
    texts = script.lecturer_texts()
    for i, t in enumerate(texts, 1):
        p = await synthesize(t, LECTURER_VOICE)
        print(f"{lesson_id} [{i}/{len(texts)}] {p.name}  {t[:24]}…")


async def check_lessons(ids: list[str], readouts: bool) -> int:
    from playwright.async_api import async_playwright

    from check import check_on_page, lint_script
    from stage import Stage

    errors = 0
    async with async_playwright() as pw:
        for lid in ids:
            script = load_script(script_path(lid))
            issues = lint_script(script)
            stage = await Stage.open(pw, LESSONS.as_uri() + "/", script.lesson, lambda _cmd: None, headless=True)
            try:
                found, texts = await check_on_page(stage, script)
            finally:
                await stage.close()
            issues += found
            errors += sum(i.level == "error" for i in issues)
            kinds = {k: sum(s.kind == k for s in script.steps) for k in ("say", "demo", "proxy", "quiz")}
            print(f"== {lid} {script.title}：{len(script.steps)} 步 {kinds}，"
                  f"{sum(i.level == 'error' for i in issues)} 个错误，{sum(i.level == 'warn' for i in issues)} 个提醒")
            for i in issues:
                print(f"  [{'错误' if i.level == 'error' else '提醒'}] {i.step}: {i.msg}")
            if readouts:
                for s in script.steps:
                    if s.id in texts:
                        print(f"  --- {s.id} 讲：{s.say}\n      页面：{' '.join(texts[s.id].split())[:600]}")
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AI 讲师")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="讲稿自检：文字规范 + 对着真实页面查目标、演示、自测题")
    c.add_argument("lessons", nargs="*", help="课号；不写 = 全部讲稿")
    c.add_argument("--readouts", action="store_true", help="打印每个演示步骤操作后的页面文字，用来核对讲稿里的数字")
    a = sub.add_parser("audio", help="预合成讲师音频")
    a.add_argument("lessons", nargs="*", help="课号；不写 = 全部讲稿")
    r = sub.add_parser("run", help="开讲")
    r.add_argument("lesson")
    r.add_argument("--from", dest="start", default=None, help="从哪个小节开始，如 s3")
    r.add_argument("--port", type=int, default=None,
                   help=f"课程服务端口，要和课程服务用的一致（默认 {default_port()}）")
    args = ap.parse_args(argv)

    try:
        if args.cmd == "check":
            return asyncio.run(check_lessons(pick(args.lessons), args.readouts))
        if args.cmd == "audio":
            for lid in pick(args.lessons):
                asyncio.run(prepare_audio(lid, load_script(script_path(lid))))
            return 0
        from player import run_lecture

        lessons = [(lid, load_script(script_path(lid))) for lid in lesson_sequence(args.lesson)]
        catalog = [(lid, load_script(script_path(lid))) for lid in all_lessons()]
        start = lessons[0][1].start_index(args.start) if args.start else 0
        asyncio.run(run_lecture(lessons, course_url(args.port or default_port()), start, catalog=catalog))
        return 0
    except ScriptError as e:
        print(f"讲稿错误：{e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:  # Ctrl+C 是正常下课
        print("\n[讲师] 下课。")
        return 0


if __name__ == "__main__":
    sys.exit(main())
