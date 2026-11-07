import asyncio

from controls import Controls
from player import Lecture
from script import Script, Step


class FakeStage:
    def __init__(self):
        self.notes = []
        self.wandered_to = None
        self._never = asyncio.Event()

    async def wait_wandered(self):
        await self._never.wait()

    async def status(self, html, paused, can_reexplain, reading=False):
        self.notes.append(html)


def lecture():
    step = Step(id="s1-01", section="s1", kind="say", target="h2", say="hi")
    stage = FakeStage()
    return Lecture(Script("X.html", "X", [step]), stage, Controls()), stage


def test_handoff_counts_down_then_moves_on():
    lec, stage = lecture()
    asyncio.run(asyncio.wait_for(lec.handoff("L03", seconds=2), 5))
    assert any("2 秒后进入 L03" in n for n in stage.notes)


def test_space_during_countdown_stays_until_resumed():
    lec, stage = lecture()

    async def go():
        task = asyncio.create_task(lec.handoff("L03", seconds=3))
        await asyncio.sleep(0.2)
        lec.controls.command("toggle")  # 学生按空格：留在本课
        await asyncio.sleep(3.5)
        assert not task.done()
        assert any("留在本课" in n for n in stage.notes)
        lec.controls.command("toggle")  # 再按空格：进入下一课
        await asyncio.wait_for(task, 1)

    asyncio.run(go())
