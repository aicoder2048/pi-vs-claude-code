from tts import SentenceStream, audio_name, clean_text, split_sentences


def test_audio_name_is_stable_and_voice_specific():
    a = audio_name("v1", "你好。")
    assert a == audio_name("v1", "你好。")
    assert a != audio_name("v2", "你好。")


def test_clean_text_strips_markdown():
    assert clean_text("**结论**：用 `Router`。\n- 第一点") == "结论：用 Router。 第一点"


def test_split_sentences_on_chinese_punctuation():
    assert split_sentences("先说结论。为什么？因为快！") == ["先说结论。", "为什么？", "因为快！"]


def test_split_sentences_merges_tiny_fragments():
    assert split_sentences("好。我们继续看下一张图。") == ["好。我们继续看下一张图。"]


def test_stream_yields_only_new_complete_sentences():
    s = SentenceStream()
    assert s.feed("第一句话说完了。第二句") == ["第一句话说完了。"]
    assert s.feed("第一句话说完了。第二句也说完了。第三") == ["第二句也说完了。"]
    assert s.flush() == ["第三"]


def test_stream_merges_short_sentence_across_newline():
    # 助教常以“结论：”开头再换行。短句并入下一句后，原文里夹着换行，定位不能靠回找合并串
    s = SentenceStream()
    assert s.feed("结论：\n- 第一点很重要。第二") == ["结论：- 第一点很重要。"]
    assert s.feed("结论：\n- 第一点很重要。第二点也是。") == ["第二点也是。"]
    assert s.flush() == []


def test_stream_keeps_short_tail_until_it_grows():
    s = SentenceStream()
    assert s.feed("是。\n") == []
    assert s.feed("是。\n不是。") == ["是。不是。"]


def test_stream_flush_empty_when_nothing_left():
    s = SentenceStream()
    s.feed("一句完整的话。")
    assert s.flush() == []


def test_pronounce_replaces_whole_tokens_only():
    from tts import apply_pronunciation
    table = {"EMA": "E M A", "MA": "M A", "SPY": "S P Y", "NVDA": "英伟达", "IV": "隐含波动率"}
    assert apply_pronunciation("EMA8 上穿 EMA21，MA50 托住 SPY。", table) == "E M A8 上穿 E M A21，M A50 托住 S P Y。"
    assert apply_pronunciation("NVDA 的 IV 很高", table) == "英伟达 的 隐含波动率 很高"
    # 词中间不替换：MACD 里的 MA、SPYX 里的 SPY、IVY 里的 IV 都不动
    assert apply_pronunciation("MACD 和 SPYX、IVY", table) == "MACD 和 SPYX、IVY"


def test_pronounce_prefers_longer_terms():
    from tts import apply_pronunciation
    assert apply_pronunciation("OR30 区间", {"OR": "O R", "OR30": "O R 30"}) == "O R 30 区间"


def test_load_pronunciation_skips_notes_and_missing_file(tmp_path):
    from tts import load_pronunciation
    p = tmp_path / "pronounce.json"
    assert load_pronunciation(p) == {}
    p.write_text('{"_说明": "注释", "EMA": "E M A"}', encoding="utf-8")
    assert load_pronunciation(p) == {"EMA": "E M A"}


def test_synthesize_uses_spoken_form_for_cache_name(tmp_path, monkeypatch):
    import asyncio
    import tts
    seen = []
    async def fake_edge(text, voice, path):
        seen.append(text); path.write_bytes(b"x")
    monkeypatch.setattr(tts, "_edge", fake_edge)
    monkeypatch.setattr(tts, "PRONOUNCE", {"EMA": "E M A"})
    p = asyncio.run(tts.synthesize("看 EMA。", "v", tmp_path))
    assert seen == ["看 E M A。"]
    assert p.stem == tts.audio_name("v", "看 E M A。")
