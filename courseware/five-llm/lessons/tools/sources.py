"""课程的来源清单（tools/sources.json）：读取、按课挑选助教资料、找出没登记的引用。

serve.py 和单元测试都用它。这里只有纯逻辑，不发网络请求。
"""

import html
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

PER_SOURCE_CHARS = 60_000
DEFAULT_BUDGET_CHARS = 200_000
SNAPSHOT_KINDS = ("git", "file")


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class Course:
    title: str
    prefix: str
    port: int
    persona: str
    rules: tuple = ()
    budget: int = DEFAULT_BUDGET_CHARS


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    path: str
    scope: object                 # "all" | "cited" | 课程文件名元组（列出的课一定带，其余课提到时也带）
    aliases: tuple = ()
    snapshot: dict | None = None

    def needles(self) -> tuple:
        """课文里提到这个来源时可能用的写法：去掉 ../ 前缀的路径，加上 aliases。"""
        p = re.sub(r"^(\.\./|\./)+", "", self.path)
        return tuple(dict.fromkeys(n for n in (p, *self.aliases) if n))


@dataclass
class Selection:
    kept: list = field(default_factory=list)       # [(Source, text)]
    omitted: list = field(default_factory=list)    # [Source]：超出预算
    missing: list = field(default_factory=list)    # [Source]：文件不存在


def load_manifest(path: Path) -> tuple:
    """读取 sources.json，返回 (Course, [Source])。格式不对时抛 ManifestError，并指出是哪一项。"""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ManifestError(f"缺少来源清单 {path}") from None
    except json.JSONDecodeError as e:
        raise ManifestError(f"{path} 不是合法 JSON：{e}") from None
    c = raw.get("course")
    if not isinstance(c, dict):
        raise ManifestError(f"{path}：缺少 course 段")
    for k in ("title", "prefix", "port", "persona"):
        if k not in c:
            raise ManifestError(f"{path}：course 缺少 {k}")
    rules = c.get("rules", [])
    if not isinstance(rules, list) or not all(isinstance(r, str) for r in rules):
        raise ManifestError(f"{path}：course.rules 必须是字符串列表")
    course = Course(str(c["title"]), str(c["prefix"]), int(c["port"]), str(c["persona"]),
                    tuple(rules), int(c.get("budget_chars", DEFAULT_BUDGET_CHARS)))
    items = raw.get("sources")
    if not isinstance(items, list) or not items:
        raise ManifestError(f"{path}：sources 必须是非空列表")
    out, seen = [], set()
    for i, s in enumerate(items):
        where = f"{path}：sources[{i}]"
        if not isinstance(s, dict):
            raise ManifestError(f"{where} 不是对象")
        for k in ("id", "label", "path", "scope"):
            if not isinstance(s.get(k), (str, list)) or not s.get(k):
                raise ManifestError(f"{where} 缺少 {k}")
        if s["id"] in seen:
            raise ManifestError(f"{where}：id {s['id']!r} 重复")
        seen.add(s["id"])
        scope = s["scope"]
        if isinstance(scope, list):
            if not all(isinstance(x, str) and x.endswith(".html") for x in scope):
                raise ManifestError(f"{where}：scope 列表只能写课程文件名（*.html）")
            scope = tuple(scope)
        elif scope not in ("all", "cited"):
            raise ManifestError(f"{where}：scope 只能是 all、cited 或课程文件名列表，现在是 {scope!r}")
        aliases = s.get("aliases", [])
        if not isinstance(aliases, list) or not all(isinstance(a, str) and a for a in aliases):
            raise ManifestError(f"{where}：aliases 必须是非空字符串列表")
        snap = s.get("snapshot")
        if snap is not None and (not isinstance(snap, dict) or snap.get("kind") not in SNAPSHOT_KINDS):
            raise ManifestError(f"{where}：snapshot.kind 只能是 {' 或 '.join(SNAPSHOT_KINDS)}")
        out.append(Source(s["id"], s["label"], s["path"], scope, tuple(aliases), snap))
    return course, out


def lesson_text(page_html: str) -> str:
    """课程页 HTML → 纯文本（去掉 script / style 和标签）。用于数引用，不用于显示。"""
    t = re.sub(r"<(script|style)\b.*?</\1>", " ", page_html, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    return html.unescape(t)


def _needle_re(needles) -> re.Pattern | None:
    if not needles:
        return None
    alts = sorted(needles, key=len, reverse=True)     # 长的先匹配，避免 "x/state.ts" 被记两次
    return re.compile("|".join(re.escape(n) for n in alts))


def mentions(text: str, src: Source) -> int:
    rx = _needle_re(src.needles())
    return len(rx.findall(text)) if rx else 0


def select_sources(sources, lesson: str, text: str, read, budget: int = DEFAULT_BUDGET_CHARS) -> Selection:
    """挑出这一课的助教资料。

    保留顺序：scope=all → 课文提到的（次数多的在前）→ scope 列表里列了这一课、但课文没提到的。
    每份资料先截到 PER_SOURCE_CHARS，然后按顺序放进预算；放不下的记进 omitted。
    read(Source) 返回全文，文件不存在时返回 None。
    """
    tiers = []
    for order, s in enumerate(sources):
        n = mentions(text, s)
        if s.scope == "all":
            tiers.append((0, 0, order, s))
        elif n:
            tiers.append((1, -n, order, s))
        elif s.scope != "cited" and lesson in s.scope:
            tiers.append((2, 0, order, s))
    sel, used = Selection(), 0
    for *_, s in sorted(tiers, key=lambda t: t[:3]):
        body = read(s)
        if body is None:
            sel.missing.append(s)
            continue
        if len(body) > PER_SOURCE_CHARS:
            body = body[:PER_SOURCE_CHARS] + "\n…（已截断）"
        if used + len(body) > budget:
            sel.omitted.append(s)
            continue
        sel.kept.append((s, body))
        used += len(body)
    return sel


FILE_REF = re.compile(
    r"(?<![\w/.-])(?:[\w.-]+/)*[\w-]+(?:\.[\w-]+)*\."
    r"(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|jsonl|go|rs|java|kt|swift|rb|c|cc|cpp|h|hpp|cs|php|sh|ya?ml|toml|sql|ipynb|pdf|txt)\b"
)
TITLE_REF = re.compile(r"《[^》\n]{2,60}》")


def unregistered_refs(text: str, sources) -> list:
    """课文里像文件名或《书名》的引用，但没有任何来源的 path / alias 落在里面。按出现次数排序。"""
    needles = [n for s in sources for n in s.needles()]
    counts = {}
    for m in list(FILE_REF.finditer(text)) + list(TITLE_REF.finditer(text)):
        tok = m.group(0)
        bare = tok.strip("《》")
        if any(n in tok or (tok.startswith("《") and bare in n) for n in needles):
            continue
        counts[tok] = counts.get(tok, 0) + 1
    return sorted(counts, key=lambda k: (-counts[k], k))


# ---------- 勘误：助教发现课文与资料矛盾时，在回答末尾输出 ```errata 代码块 ----------

ERRATA_BLOCK = re.compile(r"```errata[ \t]*\n(.*?)(?:```|\Z)", re.S)
ERRATA_FIELDS = {"section": 200, "claim": 300, "evidence": 500, "source": 200}
ERRATA_MARK = re.compile(r"^<!-- errata (\{.*\}) -->$", re.M)


def strip_errata(text: str) -> str:
    return ERRATA_BLOCK.sub("", text).rstrip()


def parse_errata(answer: str, lesson: str) -> list:
    """取出回答里的勘误块。坏 JSON、缺 claim 或 evidence 的块丢掉。lesson 以服务端知道的为准。"""
    out = []
    for m in ERRATA_BLOCK.finditer(answer):
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        for e in obj if isinstance(obj, list) else [obj]:
            if not isinstance(e, dict):
                continue
            item = {k: str(e.get(k) or "").strip()[:n] for k, n in ERRATA_FIELDS.items()}
            if item["claim"] and item["evidence"]:
                out.append({"lesson": lesson, **item})
    return out


def errata_key(e: dict) -> str:
    return e["lesson"] + "|" + re.sub(r"[\W_]+", "", e["claim"]).lower()


def read_errata(path: Path) -> list:
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for m in ERRATA_MARK.finditer(p.read_text(encoding="utf-8")):
        try:
            out.append(json.loads(m.group(1)))
        except json.JSONDecodeError:
            continue
    return out


def add_errata(path: Path, entries: list, date: str) -> list:
    """把没记过的勘误追加到 errata.md，返回真正新增的条目。"""
    p = Path(path)
    seen = {errata_key(e) for e in read_errata(p)}
    new = []
    for e in entries:
        k = errata_key(e)
        if k not in seen:
            seen.add(k)
            new.append({**e, "date": date})
    if not new:
        return []
    text = p.read_text(encoding="utf-8") if p.exists() else (
        "# 疑似勘误\n\nAI 助教发现课文与资料矛盾时记在这里。作者核实后修改课文，再删掉对应条目。\n")
    for e in new:
        text += (f"\n## {e['lesson']}" + (f" · {e['section']}" if e["section"] else "") + "\n\n"
                 f"- 课文：{e['claim']}\n- 资料：{e['evidence']}" + (f"（{e['source']}）" if e["source"] else "") + "\n"
                 f"- 记录：{e['date']}\n"
                 f"<!-- errata {json.dumps(e, ensure_ascii=False)} -->\n")
    p.write_text(text, encoding="utf-8")
    return new
