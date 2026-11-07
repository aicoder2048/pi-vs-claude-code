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
