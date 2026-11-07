"""语音合成：edge-tts 为主，macOS `say` 兜底，按"声音 + 文本"缓存到 audio/。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path

LECTURER_VOICE = "zh-CN-YunxiNeural"
TUTOR_VOICE = "zh-CN-XiaoxiaoNeural"
# edge-tts 不可用时，用 macOS 自带声音
SAY_FALLBACK = {LECTURER_VOICE: "Eddy", TUTOR_VOICE: "Tingting"}

AUDIO_DIR = Path(__file__).parent / "audio"
_END = "。！？；!?;\n"
_MIN_LEN = 4  # 短于这个长度的句子并到下一句，避免碎读


PRONOUNCE_FILE = Path(__file__).parent / "pronounce.json"


def load_pronunciation(path: Path = PRONOUNCE_FILE) -> dict[str, str]:
    """课程的读音表：{"原词": "读法"}。以 _ 开头的键是注释。没有文件就是空表。"""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        raise SystemExit(f"读音表 {path} 不是合法 JSON：{e}") from e
    return {k: str(v) for k, v in raw.items() if not k.startswith("_")}


PRONOUNCE = load_pronunciation()


def apply_pronunciation(text: str, table: dict[str, str]) -> str:
    """把读音表里的词换成读法。只换完整的词：前后不能紧挨英文字母（可以紧挨数字，如 EMA8）。长词优先。"""
    if not table:
        return text
    terms = sorted(table, key=len, reverse=True)
    pat = re.compile(r"(?<![A-Za-z])(" + "|".join(map(re.escape, terms)) + r")(?![A-Za-z])")
    return pat.sub(lambda m: table[m.group(1)], text)


def audio_name(voice: str, text: str) -> str:
    return hashlib.sha1(f"{voice}\n{text}".encode()).hexdigest()[:16]


def clean_text(s: str) -> str:
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\*\*?([^*]+)\*\*?", r"\1", s)
    s = re.sub(r"^\s*(#{1,6}|[-*•]|\d+[.)、])\s+", "", s, flags=re.M)
    s = s.replace("|", " ")
    return re.sub(r"\s+", " ", s).strip()


def _raw_sentences(text: str) -> tuple[list[tuple[str, int]], str]:
    """切出完整句子，返回（[(句子, 它在 text 里的结束偏移)]，剩下的不完整尾巴）。"""
    out, buf = [], ""
    for i, ch in enumerate(text):
        buf += ch
        if ch in _END:
            if buf.strip():
                out.append((buf.strip(), i + 1))
            buf = ""
    return out, buf


def _merge(sents: list[str]) -> tuple[list[str], str, int]:
    """把太短的句子并到下一句。返回（合并后的句子，不够长的尾巴，并进结果的原句数）。"""
    out: list[str] = []
    carry, used = "", 0
    for k, s in enumerate(sents):
        carry += s
        if len(carry) >= _MIN_LEN:
            out.append(carry)
            carry = ""
            used = k + 1
    return out, carry, used


def split_sentences(text: str) -> list[str]:
    raw, tail = _raw_sentences(text)
    sents = [s for s, _ in raw]
    if tail.strip():
        sents.append(tail.strip())
    out, carry, _ = _merge(sents)
    return out + [carry] if carry else out


class SentenceStream:
    """喂入"到目前为止的全文"，只吐出新完成的句子。用于边生成边朗读。"""

    def __init__(self) -> None:
        self._done = 0  # 已吐出的字符数
        self._last = ""

    def feed(self, text_so_far: str) -> list[str]:
        self._last = text_so_far
        raw, _ = _raw_sentences(text_so_far[self._done:])
        ready, _, used = _merge([s for s, _ in raw])
        if used:
            # 按原始句子的结束偏移推进：合并后的句子去掉了句间的换行和空白，不能拿它回原文找
            self._done += raw[used - 1][1]
        return ready

    def flush(self) -> list[str]:
        rest = self._last[self._done:].strip()
        self._done = len(self._last)
        return [rest] if rest else []


async def _edge(text: str, voice: str, path: Path) -> None:
    import edge_tts

    await edge_tts.Communicate(text, voice).save(str(path))


async def _say(text: str, voice: str, path: Path) -> None:
    proc = await asyncio.create_subprocess_exec(
        "say", "-v", SAY_FALLBACK.get(voice, "Tingting"), "-o", str(path),
        "--data-format=LEI16@22050", text,
    )
    if await proc.wait() != 0:
        raise RuntimeError(f"say 合成失败：{text[:20]}")


async def synthesize(text: str, voice: str, out_dir: Path = AUDIO_DIR) -> Path:
    """返回音频文件路径。已缓存就直接用；edge-tts 失败时退回 macOS say。"""
    text = apply_pronunciation(clean_text(text), PRONOUNCE)   # 缓存按读法命名：改了读音表会自动重新合成
    if not text:
        raise ValueError("要合成的文本是空的")
    out_dir.mkdir(parents=True, exist_ok=True)
    name = audio_name(voice, text)
    mp3 = out_dir / f"{name}.mp3"
    if mp3.exists() and mp3.stat().st_size > 0:
        return mp3
    try:
        await _edge(text, voice, mp3)
        return mp3
    except Exception as e:  # 网络或服务异常时兜底，不让整堂课停下
        mp3.unlink(missing_ok=True)
        wav = out_dir / f"{name}.wav"
        if wav.exists():
            return wav
        print(f"[tts] edge-tts 失败（{e}），改用 macOS say", file=sys.stderr)
        await _say(text, voice, wav)
        return wav
