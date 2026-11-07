"""讲稿自检：先查文字（不开浏览器），再对着真实页面查目标、演示和自测题。

对着页面检查时直接打开本地文件（file://），不需要启动课程服务，也不会调用任何模型。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from script import Script, Step

MAX_CHARS = 150
MAX_PROXY = 2
# 这些符号会被语音原样读出来，或者读得很怪
MARKDOWN = re.compile(r"[*`#_]|\[[^\]]*\]\(")
BRACKETS = re.compile(r"[（(]")


@dataclass(frozen=True)
class Issue:
    level: str  # "error"：必须改；"warn"：逐条判断
    step: str
    msg: str


def _lint_text(step: Step, field: str, text: str) -> list[Issue]:
    out = []
    if len(text) > MAX_CHARS:
        out.append(Issue("error", step.id, f"{field} 有 {len(text)} 字，超过 {MAX_CHARS} 字，拆成两步"))
    if MARKDOWN.search(text):
        out.append(Issue("warn", step.id, f"{field} 里有 Markdown 符号，会被读出来"))
    if BRACKETS.search(text):
        out.append(Issue("warn", step.id, f"{field} 里有括号注释，改成一句话说出来"))
    return out


def lint_script(script: Script) -> list[Issue]:
    issues: list[Issue] = []
    for s in script.steps:
        issues += _lint_text(s, "say", s.say)
        if s.explain:
            issues += _lint_text(s, "explain", s.explain)
        if s.kind == "proxy" and "字以内" not in s.question:
            issues.append(Issue("warn", s.id, "代问的 question 没有限定篇幅（如“请 200 字以内回答，先给结论”）"))
    proxies = [s for s in script.steps if s.kind == "proxy"]
    if not proxies:
        issues.append(Issue("warn", "-", "整课没有代问（建议 1–2 次）"))
    elif len(proxies) > MAX_PROXY:
        issues.append(Issue("warn", proxies[MAX_PROXY].id, f"代问有 {len(proxies)} 次，多于 {MAX_PROXY} 次，会拖慢节奏"))
    return issues


# ---------- 对着真实页面检查 ----------
_KIND_JS = "el => (el.type || '').toLowerCase()"
_TEXT_JS = "([s, n]) => { const el = document.querySelectorAll(s)[n]; return el ? el.innerText : null; }"
# 给人核对用：目标里有 .readout 就只取读数，否则取全部文字
_READOUT_JS = """([s, n]) => { const el = document.querySelectorAll(s)[n]; if (!el) return '';
  const r = el.matches('.readout') ? [el] : [...el.querySelectorAll('.readout')];
  return (r.length ? r : [el]).map((x) => x.innerText.trim()).join(' | '); }"""
_UNCOVERED_JS = """(used) => {
  const els = used.flatMap(([s, n]) => { const e = document.querySelectorAll(s)[n]; return e ? [e] : []; });
  const name = (c) => (c.id ? '#' + c.id + ' ' : '') + ((c.querySelector('.chart-title, .q') || c).innerText || '').trim().slice(0, 24);
  const miss = (sel) => [...document.querySelectorAll(sel)].filter((c) => !els.some((e) => c.contains(e) || e.contains(c))).map(name);
  return { demos: miss('main .chart-card'), quizzes: miss('main .quiz') };
}"""


async def _run_actions(stage, step: Step) -> list[Issue]:
    issues = []
    for a in step.actions:
        sel = a.get("set") or a.get("click")
        if sel is None:
            await stage.act(a)
            continue
        if not await stage.page.query_selector(sel):
            issues.append(Issue("error", step.id, f"页面上找不到操作对象 {sel}"))
            continue
        kind = await stage.page.eval_on_selector(sel, _KIND_JS)
        if "click" in a and kind in ("checkbox", "radio"):
            issues.append(Issue("error", step.id, f"{sel} 是复选框，用 set 给出确定状态；click 在回放时会翻转"))
        await stage.act(a)
        if "set" in a and kind not in ("checkbox", "radio"):
            got = await stage.page.eval_on_selector(sel, "el => el.value")
            if str(got) != str(a["value"]):
                issues.append(Issue("error", step.id, f"{sel} 设成 {a['value']} 后实际是 {got}（超出范围或没有这个选项）"))
    return issues


async def check_on_page(stage, script: Script) -> tuple[list[Issue], dict[str, str]]:
    """返回（问题列表，每个演示步骤操作后的页面文字）。读数用来核对讲稿里说的数字。"""
    issues: list[Issue] = []
    readouts: dict[str, str] = {}
    used: list[list] = []
    for s in script.steps:
        if not await stage.highlight(s.target, s.nth):
            issues.append(Issue("error", s.id, f"页面上找不到 target {s.target}（nth={s.nth}）"))
            continue
        if s.kind == "demo":
            issues += await _run_actions(stage, s)
            await stage.page.wait_for_timeout(300)
            first = await stage.page.evaluate(_TEXT_JS, [s.target, s.nth])
            readouts[s.id] = await stage.page.evaluate(_READOUT_JS, [s.target, s.nth])
            await _run_actions(stage, s)
            await stage.page.wait_for_timeout(300)
            if first != await stage.page.evaluate(_TEXT_JS, [s.target, s.nth]):
                issues.append(Issue("error", s.id, "同一步连做两遍，页面结果不一样；学生按 ← 回放会和讲解对不上。"
                                                   "让这一步自己先复位（如先点重置），不要依赖前一步留下的状态"))
            used.append([s.target, s.nth])
            used += [[a.get("set") or a.get("click"), 0] for a in s.actions if a.get("set") or a.get("click")]
        if s.kind == "quiz":
            used.append([s.target, s.nth])
            answer = await stage.page.evaluate(
                "([s, n]) => document.querySelectorAll(s)[n]?.dataset.answer ?? null", [s.target, s.nth])
            if answer is None:
                issues.append(Issue("error", s.id, f"{s.target}（nth={s.nth}）不是自测题（没有 data-answer）"))
            elif "ABCDEFGH"[int(answer)] not in s.explain:
                issues.append(Issue("warn", s.id, f"正确答案是 {'ABCDEFGH'[int(answer)]}，explain 里没有提到这个选项"))
    left = await stage.page.evaluate(_UNCOVERED_JS, used)
    issues += [Issue("warn", "-", f"演示没有被操作：{d}") for d in left["demos"]]
    issues += [Issue("warn", "-", f"自测题没有讲：{q}") for q in left["quizzes"]]
    return issues, readouts
