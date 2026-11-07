"""讲课流程：按讲稿逐步执行，响应学生的暂停、跳步和换个讲法。"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import urllib.request

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

from controls import Controls, next_index
from llm import ConfigError, Rewriter, load_env, pick_rewriter, require_deepseek, rewrite
from script import Script, Step
from stage import Stage, is_navigation_error
from tts import LECTURER_VOICE, TUTOR_VOICE, SentenceStream, synthesize

TUTOR_TIMEOUT = 120  # 秒


class Lecture:
    def __init__(self, script: Script, stage: Stage, controls: Controls,
                 rewriters: list[Rewriter] | None = None) -> None:
        self.script, self.stage, self.controls = script, stage, controls
        self.rewriters = rewriters or []  # 换个讲法：按顺序尝试，第一个失败就用下一个
        self.i = 0
        self.speaker = "讲师"
        self.reexplain = False
        self.seen_answer = ""        # 最后处理过的助教回答 id（「重新发送」时条数不变，只能按 id 认）
        self.poll = 0.5              # 检查右栏的间隔（秒）
        self.proxy_active = False    # 讲师正在代问，新回答不算学生的
        self.reading: asyncio.Task | None = None  # 正在朗读的助教回答（插播：讲课保持暂停）
        self.reading_index = 0                    # 正在朗读第几条助教回答
        self.reading_on = asyncio.Event()  # 朗读没被学生按空格暂停
        self.reading_on.set()

    # ---------- 状态显示 ----------
    @property
    def is_reading(self) -> bool:
        return bool(self.reading and not self.reading.done())

    async def show(self, note: str = "") -> None:
        n = len(self.script.steps)
        speaker, paused = self.speaker, self.controls.paused
        reading = self.is_reading
        if reading:  # 插播助教朗读时，按键控制的是朗读
            speaker, paused = "助教", not self.reading_on.is_set()
            note = note or ("已暂停 · 空格继续 · → 跳过" if paused else "朗读中 · 空格暂停 · → 跳过 · ← 重读")
        elif paused:
            note = note or "已暂停 · 按空格继续"
        where = "" if reading else f" · 第 {min(self.i + 1, n)}/{n} 步"  # 朗读时提示更要紧，省掉步数
        text = f"<b>{speaker}</b>{where}" + (f" · {note}" if note else "")
        with contextlib.suppress(PlaywrightError):
            await self.stage.status(text, paused, can_reexplain=bool(self.rewriters), reading=reading)

    async def toggle_reading(self) -> None:
        with contextlib.suppress(PlaywrightError):
            if self.reading_on.is_set():
                self.reading_on.clear()
                await self.stage.pause_aside()
            else:
                self.reading_on.set()
                await self.stage.resume_aside()
        await self.show()

    async def on_command(self, cmd: str) -> None:
        if cmd.startswith("replay:"):  # 🔊 重听某条助教回答
            with contextlib.suppress(ValueError):
                await self.start_reading(int(cmd.split(":", 1)[1]))
            return
        if self.is_reading:  # 插播中：按键只管朗读，不让讲课跳步
            if cmd == "toggle":
                await self.toggle_reading()
            elif cmd == "prev":
                await self.start_reading(self.reading_index)
            elif cmd in ("next", "stop"):
                await self.stop_reading()
                await self.show("已跳过 · 空格继续讲课 · 🔊 可重听")
            return  # 朗读时“换个讲法”不生效
        if cmd == "stop":
            return
        was = self.controls.paused
        self.controls.command(cmd)
        if self.controls.paused != was:
            with contextlib.suppress(PlaywrightError):  # 页面可能正在跳转
                await (self.stage.pause_audio() if self.controls.paused else self.stage.resume_audio())
        await self.show()

    # ---------- 讲 ----------
    async def speak(self, text: str, voice: str = LECTURER_VOICE) -> None:
        audio = await synthesize(text, voice)
        await self.controls.wait_unpaused()
        await self.stage.play(audio)

    async def speak_tutor_answer(self, before: int, aside: bool = False) -> None:
        """助教一边生成，这边一边按句朗读（助教的声音）。

        aside=True 用于学生自己的提问：走第二路音频，暂停时也照常读。
        """
        stream, queue = SentenceStream(), asyncio.Queue()

        async def watch() -> None:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + TUTOR_TIMEOUT
            while loop.time() < deadline:
                text, done, err = await self.stage.tutor_answer(before)
                for sent in stream.feed(text):
                    queue.put_nowait(asyncio.create_task(synthesize(sent, TUTOR_VOICE)))
                if done:
                    if err:
                        print(f"[讲师] 助教出错：{err}", file=sys.stderr)
                    for sent in stream.flush():
                        queue.put_nowait(asyncio.create_task(synthesize(sent, TUTOR_VOICE)))
                    break
                await asyncio.sleep(0.3)
            queue.put_nowait(None)

        watcher = asyncio.create_task(watch())
        self.speaker = "助教"
        try:
            while (job := await queue.get()) is not None:
                audio = await job
                if aside:
                    await self.reading_on.wait()
                    await self.stage.play_aside(audio)
                else:
                    await self.controls.wait_unpaused()
                    await self.show()
                    await self.stage.play(audio)
        finally:
            watcher.cancel()
            self.speaker = "讲师"
            if aside:
                self.reading = None  # 读完了：状态栏回到讲课
                await self.show("读完了 · 空格继续讲课 · 🔊 可重听" if self.controls.paused else "")

    # ---------- 学生自己问助教 ----------
    async def stop_reading(self) -> None:
        if self.reading:
            self.reading.cancel()
            with contextlib.suppress(asyncio.CancelledError, PlaywrightError):
                await self.reading
            self.reading = None
        self.reading_on.set()
        with contextlib.suppress(PlaywrightError):
            await self.stage.stop_aside()

    async def start_reading(self, index: int) -> None:
        """插播朗读第 index 条助教回答：讲课先暂停，读完或跳过后仍保持暂停。"""
        if self.proxy_active:  # 讲师正在代问，回答由讲师自己读
            return
        await self.stop_reading()
        if not self.controls.paused:
            self.controls.pause()
            with contextlib.suppress(PlaywrightError):
                await self.stage.pause_audio()
        self.reading_index = index
        self.reading = asyncio.create_task(self._read(index))
        await self.show()  # 一开始就换成朗读的控制条，不等第一句合成完

    async def _read(self, index: int) -> None:
        """朗读任务读完会把自己从 self.reading 摘掉，没人再 await 它：
        浏览器关了、页面跳走了，就安静结束，不留“Task exception was never retrieved”。"""
        with contextlib.suppress(PlaywrightError):
            await self.speak_tutor_answer(index, aside=True)

    async def watch_student_questions(self) -> None:
        """发现学生在右栏新问的问题，就朗读助教的回答；讲师正在讲时先暂停讲课。"""
        _, self.seen_answer = await self.stage.tutor_last()
        while True:
            await asyncio.sleep(self.poll)
            try:
                count, last = await self.stage.tutor_last()
            except PlaywrightError:  # 页面正在跳转，下一轮再看
                continue
            if self.proxy_active or last == self.seen_answer:
                continue
            self.seen_answer = last
            if not count or not last:  # 学生清空了对话
                continue
            await self.start_reading(count - 1)

    async def explain_again(self, step: Step) -> None:
        await self.show("在想另一种讲法…")
        context = await self.stage.section_text(step.target, step.nth)
        said = step.explain if step.kind == "quiz" else step.say
        for r in self.rewriters:
            try:
                text = await rewrite(r, self.script.title, said, context)
                break
            except Exception as e:  # 换下一个模型
                print(f"[讲师] {r.name} 换讲法失败：{e}", file=sys.stderr)
        else:
            await self.show("换个讲法失败了，接着往下讲")
            return
        await self.show()
        await self.speak(text)

    async def perform(self, step: Step) -> None:
        if not await self.stage.highlight(step.target, step.nth):
            print(f"[讲师] 步骤 {step.id}：页面上找不到 {step.target}，跳过", file=sys.stderr)
            return
        if self.reexplain:
            self.reexplain = False
            await self.explain_again(step)
            return
        if step.kind == "demo":
            for a in step.actions:
                await self.controls.wait_unpaused()
                await self.stage.act(a)
        await self.speak(step.say)
        if step.kind == "proxy":
            self.proxy_active = True
            try:
                before = await self.stage.ask_tutor(step.question)
                _, self.seen_answer = await self.stage.tutor_last()
            finally:
                self.proxy_active = False
            await self.speak_tutor_answer(before)
        if step.kind == "quiz":
            self.controls.pause()
            await self.show("请在页面上作答，答完按空格继续")
            await self.controls.wait_unpaused()
            await self.show()
            if not await self.stage.quiz_answered(step.target, step.nth):
                await self.stage.reveal_quiz(step.target, step.nth)
            await self.speak(step.explain)

    # ---------- 主循环 ----------
    async def run(self, start: int) -> str | None:
        """讲完返回 None；学生中途自己打开了别的页面，返回那个页面的文件名（self.i 停在没讲完的那步）。"""
        steps = self.script.steps
        self.i = start
        while self.i < len(steps):
            await self.controls.wait_unpaused()
            await self.show()
            work = asyncio.create_task(self.perform(steps[self.i]))
            jump = asyncio.create_task(self.controls.wait_jump())
            nav = asyncio.create_task(self.stage.wait_wandered())
            try:
                done, _ = await asyncio.wait({work, jump, nav}, return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:  # Ctrl+C：连同子任务一起收拾干净
                await cancel_all(work, jump, nav)
                raise
            if nav in done:
                await cancel_all(work, jump)
                return self.stage.take_wandered()
            if jump in done:
                await cancel_all(work, nav)
                with contextlib.suppress(PlaywrightError):
                    await self.stage.stop_audio()
                cmd = self.controls.take_jump() or "next"
                self.reexplain = cmd == "reexplain" and bool(self.rewriters)
                self.i = next_index(self.i, cmd, len(steps))
                continue
            await cancel_all(jump, nav)
            try:
                work.result()  # 让步骤里的异常浮上来
            except PlaywrightError as e:
                if not is_navigation_error(e):
                    raise
                await asyncio.sleep(0.5)  # 跳转事件可能比报错晚到
                if self.stage.wandered_to:
                    return self.stage.take_wandered()
                await self.stage.settle()  # 学生刷新了本页：重讲这一步
                continue
            self.i += 1
            await asyncio.sleep(0.35)  # 步骤之间留一口气
        await self.show("本课讲完了 🎉")
        return None

    async def handoff(self, next_id: str, seconds: int = 5) -> str | None:
        """讲完一课后倒数几秒进入下一课。学生按空格（或在问助教）就留在本课，再按空格才继续。

        倒数时学生自己打开了别的页面，返回那个页面的文件名，不再进入下一课。
        """
        self.controls.take_jump()
        for left in range(seconds, 0, -1):
            if self.controls.paused or self.stage.wandered_to:
                break
            await self.show(f"本课讲完了 · {left} 秒后进入 {next_id}，按空格留在本课")
            await first_of(asyncio.sleep(1), self.stage.wait_wandered())
        if self.controls.paused and not self.stage.wandered_to:
            await self.show(f"留在本课 · 按空格进入 {next_id}")
            await first_of(self.controls.wait_unpaused(), self.stage.wait_wandered())
        self.controls.take_jump()
        return self.stage.take_wandered() if self.stage.wandered_to else None


async def first_of(*aws) -> None:
    """等其中任意一个完成，其余的取消。"""
    tasks = [asyncio.ensure_future(a) for a in aws]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        await cancel_all(*tasks)


async def cancel_all(*tasks: asyncio.Task | None) -> None:
    """取消并等待子任务结束，吞掉它们的异常（浏览器可能已经关了）。"""
    live = [t for t in tasks if t and not t.done()]
    for t in live:
        t.cancel()
    await asyncio.gather(*[t for t in tasks if t], return_exceptions=True)


def check_server(base: str) -> None:
    try:
        urllib.request.urlopen(base, timeout=3).close()
    except OSError as e:
        raise SystemExit(f"连不上课程服务 {base}（{e}）。请先启动课程服务（tools/serve.py），"
                         "或者用 tools/course.py --lecture 一条命令同时启动；端口不一样时给讲师加上同样的 --port。")


def build_rewriters(env: dict[str, str]) -> list[Rewriter]:
    """Kimi 优先；Kimi 出错时退到 DeepSeek。"""
    first = pick_rewriter(env)
    if first.name == "DeepSeek":
        return [first]
    return [first, pick_rewriter({k: v for k, v in env.items() if k != "MOONSHOT_API_KEY"})]


async def run_lecture(lessons: list[tuple[str, Script]], base: str, start: int = 0,
                      headless: bool = False, catalog: list[tuple[str, Script]] | None = None) -> None:
    """从 lessons[0] 开讲，讲完一课自动进入下一课。start 只作用于第一课。

    catalog 是所有有讲稿的课（按课号排序），默认等于 lessons。学生中途自己打开别的页面时：
    那一页有讲稿，讲师就跟过去讲（讲到一半离开的课，回来接着讲）；没有讲稿，讲师暂停等他。
    """
    catalog = catalog or lessons
    by_id = dict(catalog)
    order = [lid for lid, _ in catalog]
    by_file = {s.lesson: lid for lid, s in catalog}
    env = load_env()
    try:
        require_deepseek(env)
    except ConfigError as e:
        raise SystemExit(str(e))
    check_server(base)
    rewriters = build_rewriters(env)
    print(f"[讲师] 换个讲法使用：{' → '.join(r.name for r in rewriters)}")
    controls = Controls()
    progress: dict[str, int] = {}  # 讲到一半被学生离开的课 → 停在第几步

    async with async_playwright() as pw:
        holder: dict[str, Lecture] = {}
        stage = await Stage.open(pw, base, lessons[0][1].lesson,
                                 lambda cmd: asyncio.ensure_future(holder["l"].on_command(cmd)), headless)

        async def follow(prev: str, file: str) -> tuple[str, int]:
            """学生打开了 file。返回接下来讲哪一课、从第几步讲。"""
            while True:
                await stage.settle()
                lid = by_file.get(file)
                if lid:
                    print(f"[讲师] 学生打开了 {lid}，跟过去讲")
                    controls.take_jump()
                    controls.resume()
                    return lid, progress.get(lid, 0)
                controls.pause()
                with contextlib.suppress(PlaywrightError):
                    await stage.status(f"<b>讲师</b> · 这一页没有讲稿 · 按空格回到 {prev} 接着讲，或者打开别的课",
                                       True, False)
                await first_of(controls.wait_unpaused(), stage.wait_wandered())
                if stage.wandered_to:
                    file = stage.take_wandered()
                    continue
                return prev, progress.get(prev, 0)

        lecture: Lecture | None = None
        student: asyncio.Task | None = None
        cur, i0 = lessons[0][0], start
        try:
            while True:
                script = by_id[cur]
                if stage.current != script.lesson:
                    await stage.goto(script.lesson)
                print(f"[讲师] 开讲 {cur} {script.title}" + (f"（从第 {i0 + 1} 步接着讲）" if i0 else ""))
                lecture = holder["l"] = Lecture(script, stage, controls, rewriters)
                student = asyncio.create_task(lecture.watch_student_questions())
                wandered = await lecture.run(i0)
                if wandered:
                    progress[cur] = lecture.i
                else:
                    progress.pop(cur, None)
                    k = order.index(cur)
                    if k + 1 < len(order):
                        wandered = await lecture.handoff(order[k + 1])
                        if not wandered:
                            await cancel_all(student, lecture.reading)
                            cur, i0 = order[k + 1], 0
                            continue
                    elif headless or not await stage.wait_closed_or_wandered():
                        break  # 全部讲完；学生的提问照样朗读，直到关窗口
                    else:
                        wandered = stage.take_wandered()
                await cancel_all(student, lecture.reading)
                cur, i0 = await follow(cur, wandered)
        except PlaywrightError as e:
            if "closed" not in str(e).lower():
                raise
            print("[讲师] 浏览器已关闭，下课。")
        finally:
            await cancel_all(student, lecture.reading if lecture else None)
            with contextlib.suppress(Exception):
                await stage.close()
