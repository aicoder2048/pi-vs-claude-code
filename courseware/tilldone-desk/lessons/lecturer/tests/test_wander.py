"""学生在讲课中途自己换了页面（点左栏、点链接、按后退）。"""

import asyncio
from pathlib import Path

import player
from controls import Controls
from player import Lecture
from script import Script, Step
from stage import page_file


class FakeStage:
    """够 Lecture.run 用的假讲台：play 会一直卡住，直到测试让学生换页。"""

    def __init__(self):
        self.notes = []
        self.wandered_to = None
        self._wander = asyncio.Event()
        self.playing = asyncio.Event()

    def wander(self, file):
        self.wandered_to = file
        self._wander.set()

    def take_wandered(self):
        f, self.wandered_to = self.wandered_to, None
        self._wander.clear()
        return f

    async def wait_wandered(self):
        await self._wander.wait()

    async def highlight(self, target, nth=0):
        return True

    async def status(self, html, paused, can_reexplain, reading=False):
        self.notes.append(html)

    async def play(self, audio):
        self.playing.set()
        await asyncio.sleep(3600)

    async def stop_audio(self):
        pass


def lecture(monkeypatch):
    async def fake_tts(text, voice):
        return Path("x.mp3")

    monkeypatch.setattr(player, "synthesize", fake_tts)
    steps = [Step(id=f"s1-0{i}", section="s1", kind="say", target="h2", say="hi") for i in (1, 2)]
    stage = FakeStage()
    return Lecture(Script("L01-a.html", "A", steps), stage, Controls()), stage


def test_run_returns_page_the_student_opened(monkeypatch):
    lec, stage = lecture(monkeypatch)

    async def go():
        task = asyncio.create_task(lec.run(0))
        await asyncio.wait_for(stage.playing.wait(), 2)
        stage.wander("L03-c.html")
        return await asyncio.wait_for(task, 2)

    assert asyncio.run(go()) == "L03-c.html"
    assert lec.i == 0  # 记住讲到哪一步，回来时接着讲


def test_handoff_follows_student_instead_of_counting_down(monkeypatch):
    lec, stage = lecture(monkeypatch)

    async def go():
        task = asyncio.create_task(lec.handoff("L02", seconds=5))
        await asyncio.sleep(0.2)
        stage.wander("glossary.html")
        return await asyncio.wait_for(task, 2)

    assert asyncio.run(go()) == "glossary.html"


def test_page_file_ignores_hash_and_query():
    assert page_file("http://127.0.0.1:8771/lessons/L02-x.html#s3") == "L02-x.html"
    assert page_file("http://127.0.0.1:8771/lessons/glossary.html?q=1") == "glossary.html"
    assert page_file("file:///a/lessons/L01-y.html") == "L01-y.html"
