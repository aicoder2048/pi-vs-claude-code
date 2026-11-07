from check import lint_script
from script import Script, Step


def script(*steps):
    return Script("L01-x.html", "测试课", list(steps))


def say(text, **kw):
    base = dict(id="s1-01", section="s1", kind="say", target="#s1 h2", say=text)
    base.update(kw)
    return Step(**base)


OK_TEXT = "这是一段长度合适的讲解。" * 4
PROXY = say(OK_TEXT, id="s1-09", kind="proxy", question="为什么？请 200 字以内回答，先给结论。")


def messages(issues, level):
    return [i.msg for i in issues if i.level == level]


def test_clean_script_has_no_issues():
    assert lint_script(script(say(OK_TEXT), PROXY)) == []


def test_overlong_say_is_an_error():
    issues = lint_script(script(say("很长的一句话。" * 30), PROXY))
    assert any("150" in m for m in messages(issues, "error"))


def test_overlong_quiz_explain_is_an_error():
    quiz = say(OK_TEXT, id="s1-02", kind="quiz", explain="解释太长了。" * 40)
    assert any("explain" in m for m in messages(lint_script(script(quiz, PROXY)), "error"))


def test_markdown_and_brackets_are_warned():
    issues = lint_script(script(say("这里有**加粗**和（括号注释），都会被读出来，听起来很奇怪。"), PROXY))
    assert len(messages(issues, "warn")) == 2


def test_missing_proxy_is_warned():
    assert any("代问" in m for m in messages(lint_script(script(say(OK_TEXT))), "warn"))


def test_proxy_question_without_length_limit_is_warned():
    loose = say(OK_TEXT, id="s1-09", kind="proxy", question="为什么？")
    assert any("字以内" in m for m in messages(lint_script(script(loose)), "warn"))


def test_issue_names_its_step():
    issues = lint_script(script(say("很长的一句话。" * 30, id="s3-07"), PROXY))
    assert issues[0].step == "s3-07"
