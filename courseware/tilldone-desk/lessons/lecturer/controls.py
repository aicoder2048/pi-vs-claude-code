"""学生的控制：暂停/继续、上一步/下一步、换个讲法。"""

from __future__ import annotations

import asyncio

JUMPS = {"next", "prev", "reexplain"}


def next_index(i: int, cmd: str, n: int) -> int:
    """执行跳转命令后应该讲第几步。超过末尾表示讲完。"""
    if cmd == "next":
        return i + 1
    if cmd == "prev":
        return max(0, i - 1)
    return i  # reexplain：留在本步


class Controls:
    def __init__(self) -> None:
        self._running = asyncio.Event()
        self._running.set()
        self._jumped = asyncio.Event()
        self._jump: str | None = None

    @property
    def paused(self) -> bool:
        return not self._running.is_set()

    def pause(self) -> None:
        self._running.clear()

    def resume(self) -> None:
        self._running.set()

    def command(self, cmd: str) -> None:
        if cmd == "toggle":
            self.resume() if self.paused else self.pause()
        elif cmd in JUMPS:
            self._jump = cmd
            self._jumped.set()
            self.resume()  # 跳到别的步骤就接着讲

    async def wait_unpaused(self) -> None:
        await self._running.wait()

    async def wait_jump(self) -> None:
        await self._jumped.wait()

    def take_jump(self) -> str | None:
        cmd, self._jump = self._jump, None
        self._jumped.clear()
        return cmd
