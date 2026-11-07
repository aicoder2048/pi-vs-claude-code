import json

import pytest

from script import ScriptError, load_script


def write(tmp_path, data):
    p = tmp_path / "L99.json"
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return p


def base(steps):
    return {"lesson": "L99-test.html", "title": "测试课", "steps": steps}


SAY = {"id": "s1-01", "section": "s1", "kind": "say", "target": "#s1 h2", "say": "我们开始。"}


def test_loads_valid_script(tmp_path):
    s = load_script(write(tmp_path, base([SAY])))
    assert s.steps[0].say == "我们开始。"


def test_missing_say_names_step_and_field(tmp_path):
    bad = dict(SAY)
    del bad["say"]
    with pytest.raises(ScriptError, match=r"s1-01.*say"):
        load_script(write(tmp_path, base([bad])))


def test_unknown_kind_rejected(tmp_path):
    with pytest.raises(ScriptError, match="kind"):
        load_script(write(tmp_path, base([dict(SAY, kind="dance")])))


def test_duplicate_ids_rejected(tmp_path):
    with pytest.raises(ScriptError, match="重复"):
        load_script(write(tmp_path, base([SAY, SAY])))


def test_demo_requires_actions(tmp_path):
    with pytest.raises(ScriptError, match=r"s1-02.*actions"):
        load_script(write(tmp_path, base([dict(SAY, id="s1-02", kind="demo")])))


def test_demo_action_must_be_known(tmp_path):
    step = dict(SAY, id="s1-02", kind="demo", actions=[{"jump": "#x"}])
    with pytest.raises(ScriptError, match="action"):
        load_script(write(tmp_path, base([step])))


def test_proxy_requires_question(tmp_path):
    with pytest.raises(ScriptError, match=r"s1-02.*question"):
        load_script(write(tmp_path, base([dict(SAY, id="s1-02", kind="proxy")])))


def test_quiz_requires_explain(tmp_path):
    with pytest.raises(ScriptError, match=r"s1-02.*explain"):
        load_script(write(tmp_path, base([dict(SAY, id="s1-02", kind="quiz")])))


def test_start_index_for_section(tmp_path):
    steps = [SAY, dict(SAY, id="s2-01", section="s2"), dict(SAY, id="s2-02", section="s2")]
    s = load_script(write(tmp_path, base(steps)))
    assert s.start_index("s2") == 1


def test_start_index_unknown_section(tmp_path):
    s = load_script(write(tmp_path, base([SAY])))
    with pytest.raises(ScriptError, match="s9"):
        s.start_index("s9")


def test_texts_lists_every_lecturer_line(tmp_path):
    quiz = dict(SAY, id="s1-02", kind="quiz", say="第一题。", explain="答案是 B。")
    s = load_script(write(tmp_path, base([SAY, quiz])))
    assert s.lecturer_texts() == ["我们开始。", "第一题。", "答案是 B。"]
