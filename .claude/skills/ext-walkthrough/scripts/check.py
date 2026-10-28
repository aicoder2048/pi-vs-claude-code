"""走读页静态检查：python3 -I .claude/skills/ext-walkthrough/scripts/check.py walkthroughs/<ext>.html

检查项：标签配对、h2 是否都有 id、内联 JS 语法（node --check）、
不许出现 dist 的 .js 行号、源码链接指向的文件存在且行号不越界。
"""
import html.parser
import pathlib
import re
import subprocess
import sys
import tempfile

VOID = {"meta", "link", "br", "hr", "input", "img"}


class TagChecker(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack, self.errors, self.h2_without_id = [], [], 0

    def handle_starttag(self, tag, attrs):
        if tag == "h2" and "id" not in dict(attrs):
            self.h2_without_id += 1
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        else:
            self.errors.append(f"标签不配对 </{tag}> 于 {self.getpos()}，栈顶 {self.stack[-3:]}")


def main(path: pathlib.Path) -> int:
    text = path.read_text(encoding="utf-8")
    problems = []

    tags = TagChecker()
    tags.feed(text)
    problems += tags.errors
    if tags.stack:
        problems.append(f"未闭合标签：{tags.stack}")
    if tags.h2_without_id:
        problems.append(f"{tags.h2_without_id} 个 h2 没有 id（右侧目录取不到）")

    scripts = re.findall(r"<script>(.*?)</script>", text, re.S)
    for i, js in enumerate(scripts):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(js)
        r = subprocess.run(["node", "--check", f.name], capture_output=True, text=True)
        if r.returncode:
            problems.append(f"第 {i + 1} 段内联 JS 语法错误：\n{r.stderr.strip()}")

    for m in re.findall(r"[A-Za-z-]+\.js:\d+", text):
        problems.append(f"出现 dist 行号 {m}，应改为 TS 源码链接")

    links = 0
    for href in re.findall(r'href="(\.\./[^"#]+\.ts)#L(\d+)"', text):
        rel, line = href[0], int(href[1])
        target = (path.parent / rel).resolve()
        links += 1
        if not target.exists():
            problems.append(f"源码文件不存在：{rel}")
            continue
        n = sum(1 for _ in target.open(encoding="utf-8"))
        if line > n:
            problems.append(f"行号越界：{target.name}#L{line}（共 {n} 行）")

    print(f"{path.name}：{links} 条源码链接，{len(scripts)} 段脚本")
    for p in problems:
        print("✖", p)
    print("OK" if not problems else f"{len(problems)} 个问题")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法：python3 -I .claude/skills/ext-walkthrough/scripts/check.py walkthroughs/<ext>.html")
    sys.exit(main(pathlib.Path(sys.argv[1])))
