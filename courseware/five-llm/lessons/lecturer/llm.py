"""换个讲法：让 LLM 把当前一步换个角度重讲。Kimi 优先，没有 Kimi key 时用 DeepSeek。

key 从 lessons/.env 读（与 AI 助教共用）。DeepSeek key 是必需的：助教和兜底都靠它。
"""

from __future__ import annotations

import asyncio
import json
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
KIMI_URL = "https://api.kimi.com/coding/v1/chat/completions"  # Kimi Code 包月 key 用这个地址
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"

PROMPT = """你是这门课的讲师，正在用语音给学生讲《{title}》。学生说刚才这一步没听懂。

刚才讲的是：
{said}

页面上对应的内容：
{context}

请换一个角度重新讲一遍：用一个生活中的比方或具体场景，先给结论。
要求：口语化的中文短句，150 字以内，不要 Markdown、括号注释或表情符号，不要说"好的"之类的开场白。"""


class ConfigError(RuntimeError):
    """缺少必需的配置。"""


@dataclass(frozen=True)
class Rewriter:
    name: str
    url: str
    key: str
    model: str
    extra: dict


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("'\"")
    return env


def require_deepseek(env: dict[str, str]) -> None:
    if not env.get("DEEPSEEK_API_KEY"):
        raise ConfigError(f"缺少 DEEPSEEK_API_KEY：AI 讲师需要它（助教答疑、换个讲法兜底）。请在 {ENV_PATH} 里配置。")


def pick_rewriter(env: dict[str, str]) -> Rewriter:
    if env.get("MOONSHOT_API_KEY"):
        return Rewriter("Kimi", KIMI_URL, env["MOONSHOT_API_KEY"], env.get("KIMI_MODEL", "k3.1-pro"),
                        {"reasoning_effort": "low", "max_tokens": 4000})
    require_deepseek(env)
    return Rewriter("DeepSeek", DEEPSEEK_URL, env["DEEPSEEK_API_KEY"],
                    env.get("DEEPSEEK_MODEL", "deepseek-flash"), {"max_tokens": 4000})


def _post(r: Rewriter, prompt: str) -> str:
    body = {"model": r.model, "messages": [{"role": "user", "content": prompt}], **r.extra}
    req = urllib.request.Request(r.url, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {r.key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.load(resp)
    text = (data["choices"][0]["message"].get("content") or "").strip()
    if not text:
        raise RuntimeError(f"{r.name} 返回了空内容")
    return text


async def rewrite(r: Rewriter, title: str, said: str, context: str) -> str:
    prompt = PROMPT.format(title=title, said=said, context=context[:3000])
    return await asyncio.to_thread(_post, r, prompt)
