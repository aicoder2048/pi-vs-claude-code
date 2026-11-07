import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from course import default_port, first_lesson, parse_args, ready_url  # noqa: E402


def parse(argv, scripts=("L01", "L02")):
    return parse_args(argv, port=8766, scripts=list(scripts))


def test_defaults_to_course_only_on_default_port():
    a = parse([])
    assert a.port == 8766 and a.lecture is None


def test_positional_port_still_works():
    assert parse(["9999"]).port == 9999


def test_port_flag():
    assert parse(["--port", "9999"]).port == 9999


def test_lecture_with_lesson_and_start():
    a = parse(["--lecture", "l02", "--port", "9999", "--from", "s3"])
    assert (a.lecture, a.port, a.start) == ("L02", 9999, "s3")


def test_from_requires_lecture():
    with pytest.raises(SystemExit):
        parse(["--from", "s3"])


def test_conflicting_ports_rejected():
    with pytest.raises(SystemExit):
        parse(["9000", "--port", "9999"])


def test_lecture_without_lesson_starts_from_first():
    a = parse(["--lecture", "--port", "9999"])
    assert (a.lecture, a.port) == ("L01", 9999)


def test_lecture_rejects_bad_lesson_id():
    with pytest.raises(SystemExit):
        parse(["--lecture", "9999"])


def test_first_lesson_is_lowest_script(tmp_path):
    for n in ("L03", "L01"):
        (tmp_path / f"{n}.json").write_text("{}")
    assert first_lesson(tmp_path) == "L01"


def test_first_lesson_none_without_scripts(tmp_path):
    assert first_lesson(tmp_path) is None


def test_ready_url_uses_the_real_lessons_dir_name():
    assert ready_url(9000, "course") == "http://127.0.0.1:9000/course/"


def test_default_port_reads_manifest(tmp_path):
    m = tmp_path / "sources.json"
    m.write_text(json.dumps({"course": {"port": 9123}}))
    assert default_port(m) == 9123


def test_lecture_without_any_script_explains_what_to_do(capsys):
    with pytest.raises(SystemExit) as e:
        parse(["--lecture"], scripts=[])
    msg = str(e.value.code)
    assert "还没有讲稿" in msg and "去掉 --lecture" in msg and "AUTHORING.md" in msg
    assert "usage:" not in capsys.readouterr().err  # 不是用法错误，不打印 usage


def test_lecture_for_a_lesson_without_script_lists_the_ones_that_have_one():
    with pytest.raises(SystemExit) as e:
        parse(["--lecture", "L09"])
    msg = str(e.value.code)
    assert "L09" in msg and "L01、L02" in msg


def test_course_without_lecture_needs_no_scripts():
    assert parse([], scripts=[]).lecture is None


# ---- 端口被占用时自动顺延 ----
from course import pick_port  # noqa: E402


def free_except(*busy):
    return lambda p: p not in busy


def test_free_port_is_used_as_is_without_notice():
    assert pick_port(8766, explicit=False, is_free=free_except()) == (8766, None)


def test_busy_default_port_moves_to_next_free_and_says_so():
    port, notice = pick_port(8766, explicit=False, is_free=free_except(8766))
    assert port == 8767
    assert "默认端口 8766 被占用" in notice and "8767" in notice


def test_busy_explicit_port_is_called_specified():
    port, notice = pick_port(9000, explicit=True, is_free=free_except(9000, 9001))
    assert port == 9002
    assert "指定端口 9000 被占用" in notice and "9001" in notice and "9002" in notice


def test_no_free_port_in_range_fails_with_advice():
    with pytest.raises(SystemExit) as e:
        pick_port(9000, explicit=False, is_free=lambda p: False, tries=3)
    assert "9000" in str(e.value.code) and "--port" in str(e.value.code)


def test_explicit_flag_is_recorded():
    assert parse(["--port", "9999"]).port_explicit is True
    assert parse(["9999"]).port_explicit is True
    assert parse([]).port_explicit is False


# ---- course.py 被信号杀掉时，课程服务不能变成孤儿、占着端口 ----
import os  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402

from course import port_free  # noqa: E402

COURSE_PY = Path(__file__).resolve().parents[2] / "tools" / "course.py"


def free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until(cond, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.1)
    return False


def _course_manifest_ok():
    try:
        json.loads((COURSE_PY.parent / "sources.json").read_text(encoding="utf-8"))
        return True
    except (OSError, ValueError):
        return False


# 模板里的 sources.json 是带占位符的草稿，服务起不来；同步到真实课程后才跑
@pytest.mark.skipif(not _course_manifest_ok(), reason="来源清单还是模板草稿，课程服务起不来")
@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGHUP, signal.SIGKILL])
def test_killed_launcher_releases_the_port(sig):
    port = free_port()
    p = subprocess.Popen([sys.executable, str(COURSE_PY), "--port", str(port)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_until(lambda: not port_free(port)), "课程服务没有启动"
        os.kill(p.pid, sig)
        p.wait(timeout=10)
        assert wait_until(lambda: port_free(port), timeout=5), f"{sig.name} 之后端口 {port} 仍被占用"
    finally:
        if p.poll() is None:
            p.kill()
        subprocess.run(f"lsof -ti :{port} -sTCP:LISTEN | xargs kill", shell=True)
