"""助教朗读是插播：空格暂停/继续，→/Esc 跳过，← 从头再读，🔊 重听任意一条；讲课始终保持暂停。"""

import asyncio

from controls import Controls
from player import Lecture
from script import Script, Step


class FakeStage:
    def __init__(self):
        self.notes, self.calls = [], []

    async def status(self, html, paused, can_reexplain, reading=False):
        self.notes.append((html, paused))
        self.reading_mode = reading

    async def pause_aside(self):
        self.calls.append("pause_aside")

    async def resume_aside(self):
        self.calls.append("resume_aside")

    async def stop_aside(self):
        self.calls.append("stop_aside")


def reading_lecture():
    step = Step(id="s1-01", section="s1", kind="say", target="h2", say="hi")
    stage = FakeStage()
    lec = Lecture(Script("X.html", "X", [step]), stage, Controls())
    lec.controls.pause()  # 学生提问时讲课已自动暂停
    return lec, stage


async def start_reading(lec):
    lec.reading = asyncio.create_task(asyncio.Event().wait())  # 一段还没读完的朗读


def test_space_pauses_reading_without_cancelling_it():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("toggle")
        assert stage.calls == ["pause_aside"]
        assert lec.reading and not lec.reading.done()
        assert "空格继续" in stage.notes[-1][0] and stage.notes[-1][1] is True
        lec.reading.cancel()

    asyncio.run(go())


def test_second_space_resumes_reading():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("toggle")
        await lec.on_command("toggle")
        assert stage.calls == ["pause_aside", "resume_aside"]
        assert lec.reading_on.is_set() and not lec.reading.done()
        assert lec.controls.paused  # 讲课仍然暂停
        lec.reading.cancel()

    asyncio.run(go())


def started(lec):
    """把 speak_tutor_answer 换成一个读不完的假朗读，记下读的是第几条。"""
    read = []

    async def fake_read(index, aside=False):
        read.append(index)
        try:
            await asyncio.Event().wait()
        finally:
            lec.reading = None
    lec.speak_tutor_answer = fake_read
    return read


def test_right_arrow_skips_reading_without_jumping_a_step():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("next")
        assert lec.reading is None and "stop_aside" in stage.calls
        assert lec.controls.paused and lec.controls.take_jump() is None and lec.i == 0
        assert "空格继续讲课" in stage.notes[-1][0]

    asyncio.run(go())


def test_left_arrow_rereads_the_same_answer():
    lec, stage = reading_lecture()
    read = started(lec)

    async def go():
        await lec.start_reading(3)
        await asyncio.sleep(0)
        await lec.on_command("prev")
        await asyncio.sleep(0)
        assert read == [3, 3] and lec.is_reading
        assert lec.controls.take_jump() is None
        lec.reading.cancel()

    asyncio.run(go())


def test_replay_button_reads_an_old_answer_and_pauses_the_lecture():
    lec, stage = reading_lecture()
    lec.controls.resume()  # 讲师正在讲
    read = started(lec)
    stage.pause_audio = lambda: asyncio.sleep(0, stage.calls.append("pause_audio"))

    async def go():
        await lec.on_command("replay:1")
        await asyncio.sleep(0)
        assert read == [1] and lec.is_reading
        assert lec.controls.paused and "pause_audio" in stage.calls
        assert stage.reading_mode is True
        lec.reading.cancel()

    asyncio.run(go())


def test_reexplain_is_ignored_while_reading():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("reexplain")
        assert lec.is_reading and lec.controls.take_jump() is None
        lec.reading.cancel()

    asyncio.run(go())


def test_escape_when_not_reading_does_nothing():
    lec, stage = reading_lecture()
    lec.controls.resume()
    asyncio.run(lec.on_command("stop"))
    assert not lec.controls.paused and stage.calls == []


def test_escape_stops_reading_and_keeps_lecture_paused():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("toggle")
        await lec.on_command("stop")
        assert lec.reading is None and "stop_aside" in stage.calls
        assert lec.controls.paused and lec.reading_on.is_set()
        assert "空格继续讲课" in stage.notes[-1][0]

    asyncio.run(go())


def test_reading_note_mentions_space_and_escape():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.show()
        lec.reading.cancel()

    asyncio.run(go())
    html, paused = stage.notes[-1]
    assert "<b>助教</b>" in html and "空格暂停" in html and "→ 跳过" in html and paused is False
    assert stage.reading_mode is True


# ---------- 认出学生的新提问 ----------
class WatchStage(FakeStage):
    """tutor_last 依次返回（助教回答条数，最后一条回答的 id），用完后停在最后一个状态。"""

    def __init__(self, states):
        super().__init__()
        self.states = list(states)

    async def tutor_last(self):
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]

    async def pause_audio(self):
        self.calls.append("pause_audio")


def watch(states, polls=8):
    step = Step(id="s1-01", section="s1", kind="say", target="h2", say="hi")
    lec = Lecture(Script("X.html", "X", [step]), WatchStage(states), Controls())
    lec.poll = 0.01
    read = []

    async def fake_read(index, aside=False):
        read.append(index)
    lec.speak_tutor_answer = fake_read

    async def go():
        task = asyncio.create_task(lec.watch_student_questions())
        await asyncio.sleep(lec.poll * polls)
        task.cancel()
    asyncio.run(go())
    return read, lec


def test_new_question_is_read():
    read, lec = watch([(1, "a"), (1, "a"), (2, "b")])
    assert read == [1] and lec.controls.paused


def test_resend_keeps_count_but_is_still_read():
    # 「重新发送」删掉出错的一问一答再问：条数不变，最后一条换了 id
    read, _ = watch([(2, "b"), (2, "b"), (2, "c")])
    assert read == [1]


def test_cleared_then_asked_again_is_read():
    read, _ = watch([(3, "c"), (0, ""), (1, "d")])
    assert read == [0]


def test_nothing_new_reads_nothing():
    read, _ = watch([(2, "b")])
    assert read == []


def test_answers_during_proxy_question_are_not_read():
    step = Step(id="s1-01", section="s1", kind="say", target="h2", say="hi")
    lec = Lecture(Script("X.html", "X", [step]), WatchStage([(1, "a"), (2, "p")]), Controls())
    lec.poll, read = 0.01, []

    async def fake_read(index, aside=False):
        read.append(index)
    lec.speak_tutor_answer = fake_read

    async def go():
        task = asyncio.create_task(lec.watch_student_questions())
        await asyncio.sleep(0.005)
        lec.proxy_active = True        # 讲师代问：回答由讲师自己读
        await asyncio.sleep(0.05)
        lec.seen_answer, lec.proxy_active = "p", False
        await asyncio.sleep(0.05)
        task.cancel()
    asyncio.run(go())
    assert read == []


def test_closing_the_browser_while_reading_raises_nothing():
    from playwright.async_api import Error as PlaywrightError

    lec, stage = reading_lecture()

    async def closed(index, aside=False):
        raise PlaywrightError("Target page, context or browser has been closed")
    lec.speak_tutor_answer = closed

    async def go():
        await lec.start_reading(0)
        task = lec.reading
        await asyncio.sleep(0)
        assert task.done() and task.exception() is None

    asyncio.run(go())


def test_after_reading_the_bar_mentions_replay():
    lec, stage = reading_lecture()

    async def go():
        await start_reading(lec)
        await lec.on_command("next")

    asyncio.run(go())
    assert "🔊" in stage.notes[-1][0]
