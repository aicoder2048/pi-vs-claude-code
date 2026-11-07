"""启动课程服务，可选同时让 AI 讲师开讲（只用标准库；讲师在它自己的 uv 环境里运行）。

    python tools/course.py [PORT] [--port PORT] [--lecture [L02] [--from s3]]

端口被占用时自动顺延到下一个空闲端口，并打印说明。只开课程时，Ctrl+C 停止。带 --lecture 时，关掉讲课的浏览器窗口或按 Ctrl+C，课程服务也一起停止。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
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


SCRIPTS = LESSONS / "lecturer" / "scripts"

NO_SCRIPTS = """还没有讲稿（lecturer/scripts/ 是空的），AI 讲师没法开讲。
  · 先上课：去掉 --lecture，只开课程和 AI 助教。
  · 要讲师：按 lecturer/AUTHORING.md 写讲稿（用 interactive-courseware 技能生成），再 --lecture。"""


def script_lessons(scripts_dir: Path = SCRIPTS) -> list[str]:
    """有讲稿的课号，按课号排序。"""
    return sorted(p.stem for p in scripts_dir.glob("*.json"))


def first_lesson(scripts_dir: Path = SCRIPTS) -> str | None:
    ids = script_lessons(scripts_dir)
    return ids[0] if ids else None


def parse_args(argv: list[str], port: int | None = None, scripts: list[str] | None = None) -> argparse.Namespace:
    """port、scripts 留给测试注入；平时从 sources.json 和 lecturer/scripts/ 读。

    讲稿缺失不是用法错误：用 SystemExit 给一句说明和下一步，不打印 usage。
    """
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
    a.port_explicit = bool(a.port or a.pos_port)
    a.port = a.port or a.pos_port or fallback
    if not 1 <= a.port <= 65535:
        ap.error(f"端口号不合法：{a.port}")
    if a.start and not a.lecture:
        ap.error("--from 只能和 --lecture 一起用")
    if not a.lecture:
        return a
    have = script_lessons() if scripts is None else scripts
    if not have:
        raise SystemExit(NO_SCRIPTS)
    if a.lecture == FIRST:
        a.lecture = have[0]
        return a
    a.lecture = a.lecture.upper()
    if not re.fullmatch(r"[A-Z]+\d+", a.lecture):
        ap.error(f"课号不对：{a.lecture}，应该像 L02 这样（字母加数字，和讲稿文件名一致）")
    if a.lecture not in have:
        raise SystemExit(f"{a.lecture} 还没有讲稿，AI 讲师没法讲这一课。有讲稿的课：{'、'.join(have)}。")
    return a


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    """能在 host:port 上绑定就算空闲。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def pick_port(wanted: int, explicit: bool, is_free=port_free, tries: int = 50) -> tuple[int, str | None]:
    """从 wanted 开始找第一个空闲端口。返回（端口，提示）；wanted 本身空闲时提示为 None。

    is_free 留给测试注入。往后 tries 个端口都被占用时，用 SystemExit 说明怎么办。
    """
    label = "指定端口" if explicit else "默认端口"
    busy: list[int] = []
    for port in range(wanted, min(wanted + tries, 65536)):
        if is_free(port):
            if not busy:
                return port, None
            also = f"（{'、'.join(map(str, busy[1:]))} 也被占用）" if len(busy) > 1 else ""
            return port, (f"{label} {wanted} 被占用{also}，自动改用下一个可用端口 {port}。"
                          f"\n  查看谁占用了 {wanted}：lsof -i :{wanted}"
                          f"\n  关闭占用 {wanted} 的进程：lsof -ti :{wanted} -sTCP:LISTEN | xargs kill")
        busy.append(port)
    raise SystemExit(f"{label} {wanted} 被占用，往后 {len(busy) - 1} 个端口也都被占用。请用 --port 指定一个空闲端口，"
                     f"或关闭占用 {wanted} 的进程：lsof -ti :{wanted} -sTCP:LISTEN | xargs kill")


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
    a.port, notice = pick_port(a.port, a.port_explicit)
    if notice:
        print(notice, flush=True)
    # 被 kill、关终端窗口时也要走下面的 finally，停掉讲师和课程服务，否则服务成了孤儿、一直占着端口
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(0))
    # kill -9 拦不住：把自己的 PID 告诉 serve.py，它发现父进程没了就自己退出
    env = {**os.environ, "COURSE_PARENT_PID": str(os.getpid())}
    server = subprocess.Popen([sys.executable, str(LESSONS / "tools" / "serve.py"), "--port", str(a.port)], env=env)
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
