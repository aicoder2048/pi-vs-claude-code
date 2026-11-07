"""讲台：用 Playwright 操作课程页面（高亮、演示、自测、播放音频）。"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from playwright.async_api import Browser, Frame, Page, Playwright
from playwright.async_api import Error as PlaywrightError

OVERLAY = Path(__file__).with_name("overlay.js")
LAUNCH_ARGS = ["--autoplay-policy=no-user-gesture-required", "--window-size=1500,960"]


async def _launch(pw: Playwright, headless: bool) -> Browser:
    try:  # 优先用本机 Chrome，免下载
        return await pw.chromium.launch(channel="chrome", headless=headless, args=LAUNCH_ARGS)
    except Exception:
        return await pw.chromium.launch(headless=headless, args=LAUNCH_ARGS)


def page_file(url: str) -> str:
    """网址里的页面文件名，不含 #小节 和 ?参数。"""
    return urlparse(url).path.rsplit("/", 1)[-1]


def is_navigation_error(e: Exception) -> bool:
    """页面跳走时，正在执行的页面脚本会报这类错。"""
    msg = str(e)
    return "Execution context was destroyed" in msg or "navigat" in msg.lower()


class Stage:
    def __init__(self, browser: Browser, page: Page, base: str) -> None:
        self.browser, self.page, self.base = browser, page, base
        self.current = ""                      # 页面现在是哪个文件
        self.wandered_to: str | None = None    # 学生自己打开的页面（不是讲师 goto 的）
        self._wander = asyncio.Event()
        page.on("framenavigated", self._on_navigated)

    def _on_navigated(self, frame: Frame) -> None:
        if frame.parent_frame is not None:
            return
        f = page_file(frame.url)
        if f and f != self.current:  # 同一页里跳 #小节 不算
            self.current = f
            self.wandered_to = f
            self._wander.set()

    def take_wandered(self) -> str | None:
        f, self.wandered_to = self.wandered_to, None
        self._wander.clear()
        return f

    async def wait_wandered(self) -> None:
        await self._wander.wait()

    async def settle(self) -> None:
        """等学生打开的新页面加载完。"""
        with contextlib.suppress(PlaywrightError):
            await self.page.wait_for_load_state("networkidle")

    @classmethod
    async def open(cls, pw: Playwright, base: str, lesson: str,
                   on_cmd: Callable[[str], None], headless: bool = False) -> "Stage":
        browser = await _launch(pw, headless)
        ctx = await browser.new_context(no_viewport=True)
        await ctx.add_init_script(path=str(OVERLAY))
        await ctx.expose_binding("__lecturerCmd", lambda _src, cmd: on_cmd(cmd))
        stage = cls(browser, await ctx.new_page(), base)
        await stage.goto(lesson)
        return stage

    async def goto(self, lesson: str) -> None:
        self.current = page_file(lesson)  # 先记下，自己的跳转不算学生换页
        await self.page.goto(self.base + lesson, wait_until="networkidle")

    async def close(self) -> None:
        await self.browser.close()

    async def wait_closed(self) -> None:
        await self.page.wait_for_event("close", timeout=0)

    async def wait_closed_or_wandered(self) -> bool:
        """讲完以后：学生关窗口返回 False，打开别的页面返回 True。"""
        closed = asyncio.ensure_future(self.wait_closed())
        wander = asyncio.ensure_future(self.wait_wandered())
        done, pending = await asyncio.wait({closed, wander}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        return wander in done and not closed.done()

    # ---------- 讲台反馈 ----------
    async def highlight(self, target: str, nth: int = 0) -> bool:
        return await self.page.evaluate("([s, n]) => __lecturer.highlight(s, n)", [target, nth])

    async def status(self, html: str, paused: bool, can_reexplain: bool, reading: bool = False) -> None:
        """reading=True：正在插播助教朗读，控制条换成 ↺ 从头读 / ⏯ / ⏭ 跳过。"""
        await self.page.evaluate("([h, p, r, t]) => __lecturer.status(h, p, r, t)", [html, paused, can_reexplain, reading])

    # ---------- 音频 ----------
    async def play(self, audio: Path) -> None:
        """播放讲稿音频（经课程服务器的 /lessons/lecturer/audio/ 提供），播完才返回。"""
        await self.page.evaluate("u => __lecturer.play(u)", f"{self.base}lecturer/audio/{audio.name}")

    async def pause_audio(self) -> None:
        await self.page.evaluate("__lecturer.pause()")

    async def resume_audio(self) -> None:
        await self.page.evaluate("__lecturer.resume()")

    async def stop_audio(self) -> None:
        await self.page.evaluate("__lecturer.stop()")

    async def play_aside(self, audio: Path) -> None:
        """另一路音频：朗读学生自己提问的回答，不影响讲师暂停中的那段。"""
        await self.page.evaluate("u => __lecturer.playAside(u)", f"{self.base}lecturer/audio/{audio.name}")

    async def pause_aside(self) -> None:
        await self.page.evaluate("__lecturer.pauseAside()")

    async def resume_aside(self) -> None:
        await self.page.evaluate("__lecturer.resumeAside()")

    async def stop_aside(self) -> None:
        await self.page.evaluate("__lecturer.stopAside()")

    # ---------- 演示 ----------
    async def act(self, action: dict) -> None:
        if "set" in action:
            await self.page.eval_on_selector(
                action["set"],
                "(el, v) => { if (el.type === 'checkbox' || el.type === 'radio') el.checked = v === 'true';"
                " else el.value = v;"
                " el.dispatchEvent(new Event('input', {bubbles: true}));"
                " el.dispatchEvent(new Event('change', {bubbles: true})); }",
                str(action["value"]).lower() if isinstance(action["value"], bool) else str(action["value"]),
            )
        elif "click" in action:
            await self.page.click(action["click"])
        elif "wait" in action:
            await self.page.wait_for_timeout(int(action["wait"]))

    async def section_text(self, target: str, nth: int) -> str:
        """目标所在小节的文字，给"换个讲法"做上下文。"""
        return await self.page.evaluate(
            "([s, n]) => { const el = document.querySelectorAll(s)[n];"
            " return el ? (el.closest('section') || el).innerText : ''; }", [target, nth])

    # ---------- 助教（右栏） ----------
    async def ask_tutor(self, question: str) -> int:
        """在右栏公开提问。返回提问前已有的助教回答条数，用来认出新回答。"""
        if not await self.page.evaluate("document.body.classList.contains('tutor-open')"):
            await self.page.click(".tutor-fab")
        before = await self.page.locator(".tutor-panel .tp-msg.ai").count()
        box = self.page.locator(".tutor-panel textarea")
        await box.fill(question)
        await box.press("Enter")
        await box.evaluate("el => el.blur()")  # 交还焦点，让快捷键继续生效
        return before

    async def tutor_last(self) -> tuple[int, str]:
        """（助教回答条数，最后一条回答的 data-id）。「重新发送」时条数不变、id 会变。"""
        return tuple(await self.page.evaluate(
            """() => {
              const msgs = document.querySelectorAll('.tutor-panel .tp-msg.ai');
              const m = msgs[msgs.length - 1];
              return [msgs.length, m ? (m.dataset.id || '') : ''];
            }"""))

    async def tutor_answer(self, before: int) -> tuple[str, bool, str]:
        """读新回答：（目前的正文，是否已答完，错误信息）。"""
        return tuple(await self.page.evaluate(
            """n => {
              const msgs = document.querySelectorAll('.tutor-panel .tp-msg.ai');
              const send = document.querySelector('.tutor-panel .tp-send');
              const busy = send && send.textContent.trim() !== '发送';
              const m = msgs[n];
              if (!m) return ['', false, ''];
              const c = m.cloneNode(true);
              const err = c.querySelector('.tp-err');
              c.querySelectorAll('.tp-dots, .tp-caret, .tp-err, .lecturer-replay, .tp-errata, .tp-tools, pre, table, svg, .md-mermaid, .md-tbl, .tp-tbl').forEach(x => x.remove());  // 图、表、代码不朗读
              return [c.innerText, !busy, err ? err.innerText : ''];
            }""", before))

    # ---------- 自测 ----------
    async def quiz_answered(self, target: str, nth: int) -> bool:
        return await self.page.evaluate(
            "([s, n]) => !!document.querySelectorAll(s)[n]?.classList.contains('done')", [target, nth])

    async def reveal_quiz(self, target: str, nth: int) -> None:
        """学生没作答时，讲师替他点出正确答案。"""
        await self.page.evaluate(
            "([s, n]) => { const q = document.querySelectorAll(s)[n];"
            " q.querySelectorAll('.opts button')[+q.dataset.answer].click(); }", [target, nth])
