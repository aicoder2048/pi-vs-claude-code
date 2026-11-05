"""课程本地服务：静态页面 + AI 助教（DeepSeek）转发。各门课的这个文件逐字相同。

以项目根目录为静态根（课程页可以链接 docs/ 下的原文），把 /api/tutor/chat 转发给 DeepSeek。
API key 只留在本机，不进浏览器；.env 和所有点文件都不对外提供。
课程名、端口、助教人设和每课的资料都写在 tools/sources.json（来源清单）里。

用法（在课程目录下）:
    uv run --no-project python tools/serve.py            # 启动服务，地址见输出
    uv run --no-project python tools/serve.py --check    # 列出每课的助教资料和没登记的引用，不启动服务

<课程目录>/.env（必须加进 .gitignore）:
    DEEPSEEK_API_KEY=...           必填
    DEEPSEEK_MODEL=deepseek-flash  可选
    DEEPSEEK_EFFORT=low            可选：low | high | max

计费提醒：DeepSeek 官方 API 按量计费（预充值）。
"""

import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sources as S

LESSONS = Path(__file__).resolve().parent.parent        # 课程目录
ROOT = LESSONS.parent                                    # 项目根目录（静态服务的根）
MANIFEST = LESSONS / "tools" / "sources.json"
API = "https://api.deepseek.com/chat/completions"
NOTES = LESSONS / "study-notes"                         # “记笔记”整理出的 Markdown 笔记
SKIP_PAGES = {"index.html", "glossary.html", "notes.html"}   # 其余 .html 都是课程页


def manifest() -> tuple:
    """每次请求都重读，改了 sources.json 不用重启服务。"""
    return S.load_manifest(MANIFEST)


SYSTEM = """你是“{title}”的 AI 助教。学员正在浏览器里自学一节互动课程，随时向你提问。{persona}

【目标】
帮学员真正弄懂这节课：是什么、为什么、怎么用、代价和局限是什么。

【语言风格：ASD-STE100 简明中文】
1. 一句只说一件事。句子短，多数不超过 25 个字。长句拆开。
2. 用主动语态，主语明确。
3. 先给结论，再给理由，最后给例子。
4. 同一个东西始终用同一个词，沿用原文的术语。
5. 术语第一次出现时，用一句大白话解释，并给英文原词。
6. 数字要具体，引用原文数据时带上单位和条件。
7. 不堆砌形容词，不用感叹号，不说空话套话（如“非常好的问题”“希望对你有帮助”）。

【深入浅出】
- 先用一个生活化的比喻讲透核心，再落到原文的具体机制。
- 一次只讲一个要点。学员懂了，再往深处走一层。

【篇幅与格式】
- 默认 120–300 字（图和表不计入）。学员说“展开”“详细讲”时再写长。
- 最多用 3–5 条短列表；可以用 **加粗** 标出关键词。不用多级标题。
- 结尾不总结重复，不客套。需要时，用一句话提一个值得继续想的问题。

【多画图、多用表：让结构一眼看清】
- 讲流程、步骤、调用顺序、状态变化、数据怎么流动时，先画一张图，再用文字解释图。图用 Mermaid 代码块（```mermaid）：
  - 步骤与分支：flowchart TD 或 flowchart LR
  - 谁调用谁、消息的先后：sequenceDiagram
  - 状态怎样转换：stateDiagram-v2
- 对比两个以上的东西，或列参数、字段、优缺点时，用 Markdown 表格（2–4 列，3–8 行）。
- Mermaid 写法：节点文字短（不超过 12 个字）；文字里有括号、冒号、引号等符号时，整段用双引号包起来，如 A["settle（外循环）"]；一张图不超过 12 个节点；一次回答最多 2 张图。
- 一句话能说清的简单问题，不要硬画图。

【内容规则】
1. 以原文和课程页面为准。明确区分“原文说的”和“我补充的”。原文没说的，不能说成原文说的。
2. 保留原文的限定语（如“初步”“原型”“尚未默认开启”），不要夸大。
3. 学员附上配图截图、演示读数时：先说看到了什么，再对照本课内容解释。看不清就直说，不要猜。
4. 学员说“考考我”：一次只出一道题，等他作答后再讲评。
5. 学员问到附带资料里的内容时，引用资料的标签和其中的名字（函数名、小节标题、图号）。资料没给的，直说不知道。
"""


NOTE_SYSTEM = """你是一位专业的学习笔记整理师。学员在自学“{course}”时，和 AI 助教有几段对话。请把选中的对话整理成一篇结构清楚、可以长期保存和复习的中文学习笔记。

【输出】只输出笔记的 Markdown 正文，不要加 ``` 包裹，不要写 YAML 头。结构如下：
# 笔记标题（不超过 20 个字，点出主题，不要写“学习笔记”四个字）
> 一句话摘要：这篇笔记讲清了什么。

## 核心要点
3–6 条，每条一句话，先结论。

## 详解
按主题重新组织成 2–5 个 ### 小节，不按问答顺序。合并重复，去掉寒暄、“好问题”、追问过程。

## 易错点与待思考
可选。列出容易混淆的地方、对话里没解决的问题。

【图和表】
- 涉及流程、步骤、调用顺序、状态变化时，必须画 Mermaid 图（```mermaid，flowchart / sequenceDiagram / stateDiagram-v2）。节点文字短；含括号、冒号等符号时用双引号包起来；一张图不超过 12 个节点。
- 涉及对比、参数、字段、取舍时，用 Markdown 表格。
- 对话里已有的图和表，修正后保留。

【范围与篇幅】
- 笔记只写选中对话里讨论到的问题。课程页面全文只用来核对事实、统一术语，对话没涉及的课程内容一律不写。
- 篇幅跟着对话走：大约是对话字数的 1–2 倍，最多 1500 字（图和表不计）。1–2 轮简短对话，写一篇短笔记就够，不要凑满所有小节。
- 图最多 2 张，表最多 3 张。

【内容规则】
1. 只用对话和课程页面里出现的事实，不新增事实。原文没说、助教补充的内容，标注“（助教补充）”。
2. 保留原文的限定语（如“推断”“原型”“尚未验证”），不要夸大。
3. 写作用 ASD-STE100 简明中文：一句一事，句子短，主动语态，同一个东西始终用同一个词，术语第一次出现时给英文原词。
4. 代码、文件名、函数名用 `行内代码`。
"""


def system_prompt(course) -> str:
    rules = [*course.rules, f"今天是 {datetime.date.today().isoformat()}。不要编造资料之外的新进展。"]
    extra = "".join(f"{i}. {r}\n" for i, r in enumerate(rules, 6))
    return SYSTEM.replace("{title}", course.title).replace("{persona}", course.persona) + extra


def read_source(src) -> str | None:
    f = ROOT / src.path
    return f.read_text(encoding="utf-8") if f.is_file() else None


def lesson_sources(lesson: str, course=None, sources=None) -> "S.Selection":
    """按 sources.json 挑出这一课的助教资料。课文取自磁盘上的课程页，不信任浏览器传来的文字。"""
    if sources is None:
        course, sources = manifest()
    text = S.lesson_text((LESSONS / lesson).read_text(encoding="utf-8"))
    return S.select_sources(sources, lesson, text, read_source, course.budget)


def sources_block(sel) -> str:
    out = "\n【本课附带的资料，下面逐份给出全文】" + "；".join(s.label for s, _ in sel.kept) + "。回答时可以直接引用它们。\n"
    out += "".join(f"\n--- {s.label}（{s.path}）---\n{body}\n" for s, body in sel.kept)
    if sel.omitted:
        out += "\n【超出资料预算，本课没有附上】" + "、".join(s.label for s in sel.omitted) + "。学员问到它们时，直说手上没有。\n"
    if sel.missing:
        out += "\n【资料文件缺失】" + "、".join(f"{s.label}（{s.path}）" for s in sel.missing) + "。不要假装读过它们。\n"
    return out


def lesson_files() -> set:
    return {p.name for p in LESSONS.glob("*.html") if p.name not in SKIP_PAGES}


def load_env() -> dict:
    env = {}
    f = LESSONS / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def clip(s, n: int) -> str:
    s = s if isinstance(s, str) else ""
    return s if len(s) <= n else s[:n] + "\n…（已截断）"


def build_messages(req: dict, with_image: bool = True) -> list:
    lesson = req.get("lesson", "")
    if lesson not in lesson_files():
        raise ValueError("unknown lesson")
    ctx = req.get("context") or {}
    history = req.get("messages") or []
    check_history(history)
    if history[-1]["role"] != "user":
        raise ValueError("last message must be from the user")

    course, sources = manifest()
    # 稳定前缀（system + 资料 + 课程全文），让 DeepSeek 的前缀缓存跨轮命中
    system = system_prompt(course) + (
        f"\n\n=== 本课：{clip(ctx.get('title'), 200)}（{lesson}）===\n"
        + sources_block(lesson_sources(lesson, course, sources)) +
        f"\n--- 课程页面全文（演示由页面 JS 实时计算，这里只有文字部分）---\n{clip(ctx.get('lessonText'), 50000)}\n"
    )
    msgs = [{"role": "system", "content": system}]
    for m in history[:-1]:
        msgs.append({"role": m["role"], "content": clip(m["content"], 8000)})

    parts = []
    if ctx.get("section"):
        parts.append(f"【学员正在看的小节】{clip(ctx['section'], 200)}")
    if ctx.get("selection"):
        parts.append(f"【学员选中的文字】\n{clip(ctx['selection'], 3000)}")
    if ctx.get("chart"):
        parts.append(f"【附上的图示/演示】{clip(ctx['chart'], 1500)}")
    if ctx.get("readouts"):
        parts.append(f"【这一节图示的说明、图中文字或演示读数】\n{clip(ctx['readouts'], 4000)}")
    text = ("\n".join(parts) + "\n\n【问题】" if parts else "") + clip(history[-1]["content"], 4000)
    image = ctx.get("image")
    if with_image and isinstance(image, str) and image.startswith("data:image/") and len(image) < 6_000_000:
        msgs.append({"role": "user", "content": [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": image}}]})
    else:
        msgs.append({"role": "user", "content": text})
    return msgs


def check_history(history, max_n: int = 40) -> None:
    if not isinstance(history, list) or not history or len(history) > max_n:
        raise ValueError(f"messages must be a non-empty list (max {max_n})")
    for m in history:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise ValueError("bad message")


def build_note_messages(req: dict) -> list:
    lesson = req.get("lesson", "")
    if lesson not in lesson_files():
        raise ValueError("unknown lesson")
    history = req.get("messages") or []
    check_history(history)
    ctx = req.get("context") or {}
    talk = "\n\n".join(("【学员问】\n" if m["role"] == "user" else "【助教答】\n") + clip(m["content"], 8000) for m in history)
    hint = clip(req.get("hint"), 200).strip()
    user = (
        f"本课：{clip(ctx.get('title'), 200)}（{lesson}）\n"
        + (f"学员希望笔记的标题或重点：{hint}\n" if hint else "")
        + f"\n=== 选中的对话（{len(history)} 条）===\n{talk}\n"
        + f"\n=== 课程页面全文（供核对事实，不要照抄）===\n{clip(ctx.get('lessonText'), 30000)}\n"
    )
    return [{"role": "system", "content": NOTE_SYSTEM.format(course=manifest()[0].title)}, {"role": "user", "content": user}]


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", title).strip("-_")
    return s[:40].strip("-_") or "note"


def save_note(req: dict, body: str, model: str) -> str:
    """把模型整理好的正文加上 YAML 头和原始问答，写进 study-notes/。返回文件名。"""
    body = re.sub(r"^\s*```(?:markdown|md)?\s*\n(.*?)\n```\s*$", r"\1", body.strip(), flags=re.S).strip()
    m = re.search(r"^#\s+(.+)$", body, flags=re.M)
    lesson = req["lesson"]
    lesson_title = clip((req.get("context") or {}).get("title"), 200).strip() or lesson
    title = (m.group(1).strip() if m else "") or clip(req.get("hint"), 40).strip() or lesson_title
    today = datetime.date.today()
    history = req["messages"]
    front = "\n".join([
        "---",
        "title: " + json.dumps(title, ensure_ascii=False),
        f"date: {today.isoformat()}",
        "course: " + json.dumps(manifest()[0].title, ensure_ascii=False),
        "lesson: " + json.dumps(lesson_title, ensure_ascii=False),
        f"lesson_file: {lesson}",
        "source: " + json.dumps(f"与 AI 助教的对话（{len(history)} 条），由 {model} 整理", ensure_ascii=False),
        "tags: [study-note, courseware]",
        "---",
        "",
    ])
    qa, n = [], 0
    for x in history:
        if x["role"] == "user":
            n += 1
            first = x["content"].strip().splitlines()[0] if x["content"].strip() else ""
            qa.append(f"### 问 {n}：{first[:40]}\n\n" + "\n".join("> " + ln for ln in x["content"].strip().splitlines()))
        else:
            qa.append(x["content"].strip())
    appendix = "\n\n---\n\n## 附：原始对话\n\n" + "\n\n".join(qa) + "\n"
    NOTES.mkdir(exist_ok=True)
    stem = f"{today:%y%m%d}-{lesson.split('-')[0]}-{slugify(title)}"
    name, k = stem + ".md", 2
    while (NOTES / name).exists():
        name, k = f"{stem}-{k}.md", k + 1
    (NOTES / name).write_text(front + "\n" + body + appendix, encoding="utf-8")
    return name


def list_notes() -> list:
    out = []
    for f in sorted(NOTES.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if NOTES.exists() else []:
        head = f.read_text(encoding="utf-8")[:1500]
        meta = dict(re.findall(r"^(title|date|lesson):\s*(.+)$", head, flags=re.M))
        for k, v in meta.items():
            try:
                meta[k] = json.loads(v) if v.startswith('"') else v
            except json.JSONDecodeError:
                pass
        out.append({"file": f.name, "title": meta.get("title", f.stem), "date": meta.get("date", ""), "lesson": meta.get("lesson", "")})
    return out


class Handler(SimpleHTTPRequestHandler):
    env: dict = {}

    def log_message(self, fmt, *args):  # 只记 API 调用和错误
        if "/api/" in (self.path or "") or (args and str(args[1])[0] in "45"):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_origin(self) -> bool:
        origin = self.headers.get("Origin") or ""
        return origin == "" or re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin) is not None

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/" + LESSONS.name + "/")
            return self.end_headers()
        if self.path == "/favicon.ico":
            self.path = "/" + LESSONS.name + "/assets/favicon.svg"
        if "/." in self.path:
            return self._json(404, {"error": "not found"})
        if self.path.startswith("/api/tutor/health"):
            key = bool(self.env.get("DEEPSEEK_API_KEY"))
            err = None if key else LESSONS.name + "/.env 里没有 DEEPSEEK_API_KEY（复制 .env.sample 为 .env 并填入你的 key）"
            try:
                _, sources = manifest()
                missing = [s.path for s in sources if s.scope == "all" and read_source(s) is None]
                if key and missing:
                    err = "还没下载原文：" + "、".join(missing) + "（见 README，运行 tools/fetch_article.py）"
            except S.ManifestError as e:
                err = str(e)
            return self._json(200, {"ok": err is None, "model": self.env.get("DEEPSEEK_MODEL", "deepseek-flash"), "error": err})
        if self.path.startswith("/api/notes"):
            return self._json(200, {"notes": list_notes()})
        return super().do_GET()

    def guess_type(self, path):  # 让浏览器直接显示 Markdown 原文
        return "text/plain; charset=utf-8" if str(path).endswith(".md") else super().guess_type(path)

    def _open_upstream(self, key: str, msgs: list, stream: bool = True, max_tokens: int = 4000):
        body = {
            "model": self.env.get("DEEPSEEK_MODEL", "deepseek-flash"),
            "messages": msgs,
            "stream": stream,
            "max_tokens": max_tokens,
            "reasoning_effort": self.env.get("DEEPSEEK_EFFORT", "low"),
        }
        if stream:
            body["stream_options"] = {"include_usage": True}
        up = urllib.request.Request(API, json.dumps(body).encode(), {
            "Authorization": "Bearer " + key, "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json"})
        return urllib.request.urlopen(up, timeout=180 if stream else 300)

    def _note(self, key: str, req: dict):
        """把勾选的对话整理成笔记（非流式），存进 study-notes/。"""
        try:
            msgs = build_note_messages(req)
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        model = self.env.get("DEEPSEEK_MODEL", "deepseek-flash")
        try:
            with self._open_upstream(key, msgs, stream=False, max_tokens=8000) as resp:
                data = json.loads(resp.read())
            choice = (data.get("choices") or [{}])[0]
            body = (choice.get("message") or {}).get("content") or ""
            if not body.strip():
                return self._json(502, {"error": "DeepSeek 没有返回内容，请重试"})
            if choice.get("finish_reason") == "length":
                body += "\n\n> ⚠ 笔记超出长度上限，结尾被截断。可以少选几条对话，再整理一次。\n"
            name = save_note(req, body, model)
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": f"DeepSeek 返回 {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"})
        except (urllib.error.URLError, TimeoutError) as e:
            return self._json(502, {"error": f"连不上 DeepSeek: {getattr(e, 'reason', e)}"})
        except OSError as e:
            return self._json(500, {"error": f"写笔记文件失败: {e}"})
        sys.stderr.write(f"笔记已保存：{NOTES.name}/{name}\n")
        return self._json(200, {"ok": True, "file": name, "path": f"{NOTES.name}/{name}"})

    def do_POST(self):
        is_note = self.path.startswith("/api/tutor/note")
        if not (is_note or self.path.startswith("/api/tutor/chat")):
            return self._json(404, {"error": "not found"})
        if not self._local_origin():
            return self._json(403, {"error": "only local pages may call the tutor"})
        key = self.env.get("DEEPSEEK_API_KEY")
        if not key:
            return self._json(500, {"error": LESSONS.name + "/.env 里没有 DEEPSEEK_API_KEY"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 8_000_000:
                raise ValueError("request too large or empty")
            req = json.loads(self.rfile.read(n))
            if not isinstance(req, dict):
                raise ValueError("bad request")
            if is_note:
                return self._note(key, req)
            msgs = build_messages(req)
        except (ValueError, json.JSONDecodeError, OSError) as e:
            return self._json(400, {"error": str(e)})

        note = None
        try:
            try:
                resp = self._open_upstream(key, msgs)
            except urllib.error.HTTPError as e:
                has_image = isinstance(msgs[-1]["content"], list)
                if not (has_image and e.code in (400, 422)):
                    raise
                # 模型不接受图片：去掉截图，只用图示说明和读数重试一次
                resp = self._open_upstream(key, build_messages(req, with_image=False))
                note = "（当前模型不支持读图，已改用图片说明和读数回答）\n\n"
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            return self._json(502, {"error": f"DeepSeek 返回 {e.code}: {detail}"})
        except urllib.error.URLError as e:
            return self._json(502, {"error": f"连不上 DeepSeek: {e.reason}"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()

        def send(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        usage, thinking = None, False
        try:
            if note:
                send({"t": note})
            with resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    usage = chunk.get("usage") or usage
                    for ch in chunk.get("choices") or []:
                        d = ch.get("delta") or {}
                        if d.get("reasoning_content") and not thinking:
                            thinking = True
                            send({"thinking": True})
                        if d.get("content"):
                            send({"t": d["content"]})
            send({"done": True, "usage": usage})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                send({"error": f"中途出错：{e}"})
            except Exception:
                pass


def check() -> int:
    """打印每课带哪些资料、超预算省略了哪些、课文里有哪些引用没登记。资料缺失时返回 1。"""
    course, sources = manifest()
    bad = 0
    for lesson in sorted(lesson_files()):
        sel = lesson_sources(lesson, course, sources)
        used = sum(len(b) for _, b in sel.kept)
        print(f"{lesson}  资料 {used:,}/{course.budget:,} 字：" + "、".join(s.id for s, _ in sel.kept))
        if sel.omitted:
            print("    超出预算未附：" + "、".join(s.id for s in sel.omitted))
        for s in sel.missing:
            print(f"    错误：资料文件缺失 {s.id}（{s.path}）")
            bad = 1
        refs = S.unregistered_refs(S.lesson_text((LESSONS / lesson).read_text(encoding="utf-8")), sources)
        if refs:
            print("    警告：引用了但没登记在 sources.json：" + "、".join(refs[:12]) + (f" 等 {len(refs)} 项" if len(refs) > 12 else ""))
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="默认用 sources.json 里的 course.port")
    ap.add_argument("--check", action="store_true", help="检查来源清单，不启动服务")
    a = ap.parse_args()
    try:
        course, _ = manifest()
    except S.ManifestError as e:
        sys.exit(f"来源清单有误：{e}")
    if a.check:
        sys.exit(check())
    a.port = a.port or course.port
    Handler.env = load_env()
    if not Handler.env.get("DEEPSEEK_API_KEY"):
        print(f"警告：{LESSONS.name}/.env 里没有 DEEPSEEK_API_KEY，AI 助教不可用（课程本身可以正常看）。")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), partial(Handler, directory=str(ROOT)))
    print(f"课程地址：http://127.0.0.1:{a.port}/{LESSONS.name}/   （AI 助教模型：{Handler.env.get('DEEPSEEK_MODEL', 'deepseek-flash')}，Ctrl+C 停止）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
