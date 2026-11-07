"""启动课程服务，可选同时让 AI 讲师开讲（只用标准库；讲师在它自己的 uv 环境里运行）。

    python tools/course.py [PORT] [--port PORT] [--lecture [L02] [--from s3]]

只开课程时，Ctrl+C 停止。带 --lecture 时，关掉讲课的浏览器窗口或按 Ctrl+C，课程服务也一起停止。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LESSONS = Path(__file__).resolve().parent.parent
FALLBACK_PORT = 8766
FIRST = "<first>"  # --lecture 不带课号


def default_port(manifest: Path = LESSONS / "tools" / "sources.json") -> int:
    """和 serve.py 一样，默认端口取 sources.json 里的 course.port。"""
    try:
        return int(json.loads(manifest.read_text(encoding="utf-8"))["course"]["port"])
    except (OSError, ValueError, KeyError, TypeError):
        return FALLBACK_PORT


def first_lesson(scripts_dir: Path = LESSONS / "lecturer" / "scripts") -> str | None:
    ids = sorted(p.stem for p in scripts_dir.glob("*.json"))
    return ids[0] if ids else None


def parse_args(argv: list[str], port: int | None = None, first: str | None = None) -> argparse.Namespace:
    """port、first 留给测试注入；平时从 sources.json 和 lecturer/scripts/ 读。"""
    fallback = port or default_port()
    ap = argparse.ArgumentParser(prog="course.py", description="启动课程服务，可选 AI 讲师")
    ap.add_argument("pos_port", nargs="?", type=int, metavar="PORT", help="端口（旧写法，等同 --port）")
    ap.add_argument("--port", type=int, default=None, help=f"课程服务端口（默认 {fallback}）")
    ap.add_argument("--lecture", metavar="LESSON", nargs="?", const=FIRST,
                    help="同时让 AI 讲师开讲这一课，如 L02；不写课号就从第一课开始。讲完自动进入下一课")
    ap.add_argument("--from", dest="start", metavar="SECTION", help="讲师从哪个小节开始，如 s3（需配合 --lecture）")
    a = ap.parse_args(argv)
    if a.pos_port and a.port and a.pos_port != a.port:
        ap.error(f"端口写了两个不同的值：{a.pos_port} 和 {a.port}")
    a.port = a.port or a.pos_port or fallback
    if not 1 <= a.port <= 65535:
        ap.error(f"端口号不合法：{a.port}")
    if a.start and not a.lecture:
        ap.error("--from 只能和 --lecture 一起用")
    if a.lecture == FIRST:
        a.lecture = first or first_lesson()
        if not a.lecture:
            ap.error("lecturer/scripts/ 里还没有讲稿，讲师没法开讲")
    elif a.lecture:
        a.lecture = a.lecture.upper()
        if not re.fullmatch(r"[A-Z]+\d+", a.lecture):
            ap.error(f"课号不对：{a.lecture}，应该像 L02 这样（字母加数字，和讲稿文件名一致）")
    return a


def ready_url(port: int, lessons_dir: str = LESSONS.name) -> str:
    """探测课程服务是否就绪的地址：课程目录名和 serve.py 一样取自磁盘，不写死 lessons。"""
    return f"http://127.0.0.1:{port}/{lessons_dir}/"


def wait_ready(port: int, server: subprocess.Popen, timeout: float = 15) -> None:
    url = ready_url(port)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise SystemExit(f"课程服务没能启动（退出码 {server.returncode}）。端口 {port} 可能被占用了。")
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return
        except OSError:
            time.sleep(0.3)
    raise SystemExit(f"等了 {timeout:.0f} 秒，课程服务还没就绪：{url}")


def main(argv: list[str] | None = None) -> int:
    a = parse_args(sys.argv[1:] if argv is None else argv)
    server = subprocess.Popen([sys.executable, str(LESSONS / "tools" / "serve.py"), "--port", str(a.port)])
    lecture = None
    try:
        if not a.lecture:
            return server.wait()
        wait_ready(a.port, server)
        cmd = ["uv", "run", "lecturer.py", "run", a.lecture, "--port", str(a.port)]
        if a.start:
            cmd += ["--from", a.start]
        lecture = subprocess.Popen(cmd, cwd=LESSONS / "lecturer")
        return lecture.wait()  # 讲课结束（浏览器关掉）就收工
    except KeyboardInterrupt:  # Ctrl+C 也发给了子进程，它们会自己干净退出
        return 0
    finally:
        for p in (lecture, server):
            if p and p.poll() is None:
                p.terminate()
        for p in (lecture, server):
            if p:
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()


if __name__ == "__main__":
    sys.exit(main())
