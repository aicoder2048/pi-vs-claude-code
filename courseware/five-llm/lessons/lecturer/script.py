"""讲稿：加载与校验。格式说明见 AUTHORING.md。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

KINDS = {"say", "demo", "proxy", "quiz"}
ACTIONS = {"set", "click", "wait"}
REQUIRED = {
    "say": ("say",),
    "demo": ("say", "actions"),
    "proxy": ("say", "question"),
    "quiz": ("say", "explain"),
}


class ScriptError(ValueError):
    """讲稿不合法。"""


@dataclass(frozen=True)
class Step:
    id: str
    section: str
    kind: str
    target: str
    say: str
    nth: int = 0
    actions: list[dict] = field(default_factory=list)
    question: str = ""
    explain: str = ""


@dataclass(frozen=True)
class Script:
    lesson: str
    title: str
    steps: list[Step]

    def start_index(self, section: str) -> int:
        for i, s in enumerate(self.steps):
            if s.section == section:
                return i
        raise ScriptError(f"讲稿里没有小节 {section}")

    def lecturer_texts(self) -> list[str]:
        """讲师要说的每一句（用于预合成音频）。"""
        out = []
        for s in self.steps:
            out.append(s.say)
            if s.explain:
                out.append(s.explain)
        return out


def _check_action(sid: str, a: dict) -> None:
    keys = set(a) & ACTIONS
    if len(keys) != 1:
        raise ScriptError(f"步骤 {sid}：action 必须恰好是 {sorted(ACTIONS)} 之一，实际是 {a}")
    if "set" in a and "value" not in a:
        raise ScriptError(f"步骤 {sid}：set action 缺少 value")


def _parse_step(raw: dict, i: int) -> Step:
    sid = raw.get("id") or f"#{i}"
    for k in ("id", "section", "kind", "target"):
        if not raw.get(k):
            raise ScriptError(f"步骤 {sid}：缺少字段 {k}")
    kind = raw["kind"]
    if kind not in KINDS:
        raise ScriptError(f"步骤 {sid}：未知的 kind {kind!r}，可选 {sorted(KINDS)}")
    for k in REQUIRED[kind]:
        if not raw.get(k):
            raise ScriptError(f"步骤 {sid}：{kind} 步骤缺少字段 {k}")
    for a in raw.get("actions", []):
        _check_action(sid, a)
    return Step(
        id=raw["id"],
        section=raw["section"],
        kind=kind,
        target=raw["target"],
        say=raw["say"],
        nth=int(raw.get("nth", 0)),
        actions=list(raw.get("actions", [])),
        question=raw.get("question", ""),
        explain=raw.get("explain", ""),
    )


def load_script(path: str | Path) -> Script:
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ScriptError(f"读不了讲稿 {path}：{e}") from e
    for k in ("lesson", "title", "steps"):
        if not data.get(k):
            raise ScriptError(f"讲稿 {path.name} 缺少字段 {k}")
    steps = [_parse_step(raw, i) for i, raw in enumerate(data["steps"])]
    seen: set[str] = set()
    for s in steps:
        if s.id in seen:
            raise ScriptError(f"步骤 id 重复：{s.id}")
        seen.add(s.id)
    return Script(lesson=data["lesson"], title=data["title"], steps=steps)
