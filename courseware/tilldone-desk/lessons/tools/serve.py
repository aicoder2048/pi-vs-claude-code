"""边牧结构精读：本地静态服务 + AI 助教（DeepSeek）转发。

以项目根目录为静态根（课程页可以链接 docs/ 下的原文），把 /api/tutor/chat 转发给 DeepSeek。
API key 只留在本机，不进浏览器；.env 和所有点文件都不对外提供。

用法（在课程目录下）:
    uv run --no-project python tools/serve.py            # http://127.0.0.1:8771/lessons/

<课程目录>/.env（必须加进 .gitignore）:
    DEEPSEEK_API_KEY=...           必填
    DEEPSEEK_MODEL=deepseek-flash  可选
    DEEPSEEK_EFFORT=low            可选：low | high | max

计费提醒：DeepSeek 官方 API 按量计费（预充值）。
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LESSONS = Path(__file__).resolve().parent.parent        # 课程目录
ROOT = LESSONS.parent                                    # 项目根目录（静态服务的根）
API = "https://api.deepseek.com/chat/completions"
DEFAULT_PORT = 8771

# ===== 课程配置：按课程修改 =====
# 每节课都会带上的原文（相对项目根目录）。多篇原文就写多项。
SOURCES = [
    ("原文《边牧（TillDone Desk）结构梳理》", "docs/articles/tilldone-desk-anatomy.md"),
]
# 个别课程额外附带的资料：{课程文件名: [(标签, 相对项目根目录的路径), ...]}
A = "../../apps/tilldone/"
PS = "../../.pi/npm/node_modules/pi-pstack/"
EXTRA = {
    "L01-overview.html": [("边牧 README", A + "README.md")],
    "L02-two-four-layers.html": [("边牧 README", A + "README.md"), ("四层讨论稿", "../../discussions/2026-10-28-four-layer-harness.md")],
    "L03-what-enters-context.html": [("扩展 L3 源码 state.ts", A + "extensions/tilldone/state.ts")],
    "L04-context-strategies.html": [("pstack 扩展源码 index.ts", PS + "extensions/pstack/index.ts"), ("扩展 L2 源码 index.ts", A + "extensions/tilldone/index.ts")],
    "L05-tilldone-split.html": [("扩展 L3 源码 state.ts", A + "extensions/tilldone/state.ts"), ("扩展 L2 源码 index.ts", A + "extensions/tilldone/index.ts")],
    "L06-pstack-meshing.html": [("pstack 扩展源码 index.ts", PS + "extensions/pstack/index.ts"), ("扩展 L3 源码 state.ts", A + "extensions/tilldone/state.ts")],
    "L07-pitfalls-review.html": [("边牧 README", A + "README.md")],
}
# 课程文件 = 课程目录下除 index.html / glossary.html 以外的所有 .html（自动发现）
SKIP_PAGES = {"index.html", "glossary.html"}

SYSTEM = """你是“边牧结构精读”的 AI 助教。学员正在浏览器里自学一节互动课程，随时向你提问。你像一位耐心、资深的 agent harness 工程师，坐在学员旁边一起读边牧的源码和结构图。

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
- 默认 120–300 字。学员说“展开”“详细讲”时再写长。
- 最多用 3–5 条短列表；可以用 **加粗** 标出关键词。不用表格，不用多级标题。
- 结尾不总结重复，不客套。需要时，用一句话提一个值得继续想的问题。

【内容规则】
1. 以原文和课程页面为准。明确区分“原文说的”和“我补充的”。原文没说的，不能说成原文说的。
2. 保留原文的限定语（如“初步”“原型”“尚未默认开启”），不要夸大。
3. 学员附上配图截图、演示读数时：先说看到了什么，再对照本课内容解释。看不清就直说，不要猜。
4. 学员说“考考我”：一次只出一道题，等他作答后再讲评。
5. 本课程讲的是一个仍在变化的本地项目，快照是提交 f112eb9（2026-11-03）。原文标“推断”的地方没有实际运行验证，回答时保留这个限定。白皮书 v1.0 不含 pstack 部分，不要用它回答 pstack 问题。
6. 学员问代码细节时，引用附带源码里的函数名和文件名；源码没给的，直说不知道。
7. 今天是 2026-11-03。不要编造原文发表之后的新进展。
"""


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
    if not isinstance(history, list) or not history or len(history) > 40:
        raise ValueError("messages must be a non-empty list (max 40)")
    for m in history:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise ValueError("bad message")
    if history[-1]["role"] != "user":
        raise ValueError("last message must be from the user")

    sources = ""
    for label, rel in SOURCES + EXTRA.get(lesson, []):
        f = ROOT / rel
        if f.exists():
            sources += f"\n--- {label} ---\n{clip(f.read_text(encoding='utf-8'), 60000)}\n"
    # 稳定前缀（system + 原文 + 课程全文），让 DeepSeek 的前缀缓存跨轮命中
    system = SYSTEM + (
        f"\n\n=== 本课：{clip(ctx.get('title'), 200)}（{lesson}）===\n"
        + sources +
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
            missing = [rel for _, rel in SOURCES if not (ROOT / rel).exists()]
            if key and missing:
                err = "还没下载原文：" + "、".join(missing) + "（见 README，运行 tools/fetch_article.py）"
            return self._json(200, {"ok": err is None, "model": self.env.get("DEEPSEEK_MODEL", "deepseek-flash"), "error": err})
        return super().do_GET()

    def guess_type(self, path):  # 让浏览器直接显示 Markdown 原文
        return "text/plain; charset=utf-8" if str(path).endswith(".md") else super().guess_type(path)

    def _open_upstream(self, key: str, msgs: list):
        body = {
            "model": self.env.get("DEEPSEEK_MODEL", "deepseek-flash"),
            "messages": msgs,
            "stream": True,
            "max_tokens": 4000,
            "reasoning_effort": self.env.get("DEEPSEEK_EFFORT", "low"),
            "stream_options": {"include_usage": True},
        }
        up = urllib.request.Request(API, json.dumps(body).encode(), {
            "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream"})
        return urllib.request.urlopen(up, timeout=180)

    def do_POST(self):
        if not self.path.startswith("/api/tutor/chat"):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    a = ap.parse_args()
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
