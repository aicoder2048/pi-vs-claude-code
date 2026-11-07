import pytest

from llm import ConfigError, load_env, pick_rewriter, require_deepseek


def test_load_env_parses_and_strips_quotes(tmp_path):
    p = tmp_path / ".env"
    p.write_text('# 注释\nDEEPSEEK_API_KEY="sk-a"\nMOONSHOT_API_KEY=sk-b\n\nBAD LINE\n', encoding="utf-8")
    assert load_env(p) == {"DEEPSEEK_API_KEY": "sk-a", "MOONSHOT_API_KEY": "sk-b"}


def test_load_env_missing_file_is_empty(tmp_path):
    assert load_env(tmp_path / "nope") == {}


def test_kimi_preferred_when_key_present():
    r = pick_rewriter({"DEEPSEEK_API_KEY": "d", "MOONSHOT_API_KEY": "k"})
    assert r.name == "Kimi" and r.model == "k3.1-pro" and r.key == "k"


def test_deepseek_fallback_without_kimi():
    r = pick_rewriter({"DEEPSEEK_API_KEY": "d", "DEEPSEEK_MODEL": "deepseek-pro"})
    assert r.name == "DeepSeek" and r.model == "deepseek-pro"


def test_deepseek_key_is_required():
    with pytest.raises(ConfigError, match="DEEPSEEK_API_KEY"):
        require_deepseek({"MOONSHOT_API_KEY": "k"})
