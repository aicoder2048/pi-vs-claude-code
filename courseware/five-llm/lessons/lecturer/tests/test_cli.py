import json

import pytest

from lecturer import all_lessons, course_url, default_port, lesson_sequence
from script import ScriptError


def test_course_url_uses_port_and_lessons_dir():
    assert course_url(9000, "lessons") == "http://127.0.0.1:9000/lessons/"


def test_course_url_rejects_bad_port():
    with pytest.raises(SystemExit):
        course_url(70000)


def test_default_port_comes_from_sources_json(tmp_path):
    m = tmp_path / "sources.json"
    m.write_text(json.dumps({"course": {"port": 9123}}))
    assert default_port(m) == 9123


def test_default_port_falls_back_without_manifest(tmp_path):
    assert default_port(tmp_path / "nope.json") == 8766


def test_lesson_sequence_from_given_lesson(tmp_path):
    for n in ("L01", "L02", "L03"):
        (tmp_path / f"{n}.json").write_text("{}")
    assert lesson_sequence("l02", tmp_path) == ["L02", "L03"]


def test_lesson_sequence_unknown_lesson(tmp_path):
    (tmp_path / "L01.json").write_text("{}")
    with pytest.raises(ScriptError, match="L05"):
        lesson_sequence("L05", tmp_path)


def _config(tmp_path, ids):
    cfg = tmp_path / "course-config.js"
    rows = ",\n".join(f'  {{ step: 1, file: "{i}-x.html", id: "{i}", title: "t", src: "s" }}' for i in ids)
    cfg.write_text(f"CL.LESSONS = [\n{rows}\n];\n")
    return cfg


def test_all_lessons_follow_course_config_order(tmp_path):
    for n in ("OS01", "OT01", "OT03B"):
        (tmp_path / f"{n}.json").write_text("{}")
    cfg = _config(tmp_path, ["OT01", "OT03b", "OS01"])
    assert all_lessons(tmp_path, cfg) == ["OT01", "OT03B", "OS01"]


def test_all_lessons_append_unlisted_scripts_sorted(tmp_path):
    for n in ("OT01", "ZZ09", "AA01"):
        (tmp_path / f"{n}.json").write_text("{}")
    cfg = _config(tmp_path, ["OT01"])
    assert all_lessons(tmp_path, cfg) == ["OT01", "AA01", "ZZ09"]


def test_all_lessons_without_config_are_sorted(tmp_path):
    for n in ("L02", "L01"):
        (tmp_path / f"{n}.json").write_text("{}")
    assert all_lessons(tmp_path, tmp_path / "missing.js") == ["L01", "L02"]


def test_lesson_sequence_uses_course_order(tmp_path):
    for n in ("OS01", "OT01", "OT02"):
        (tmp_path / f"{n}.json").write_text("{}")
    cfg = _config(tmp_path, ["OT01", "OT02", "OS01"])
    assert lesson_sequence("OT02", tmp_path, cfg) == ["OT02", "OS01"]
