"""AI 助教联网工具（web.py）的单元测试。不发网络请求：post 函数用假的代替。

运行（在课程目录下）：uv run --no-project python -m unittest discover -s tools -p "test_*.py"
"""

import json
import unittest

import web as W


class ToolCallAccumulatorTest(unittest.TestCase):
    def test_joins_streamed_fragments_by_index(self):
        acc = W.ToolCallAccumulator()
        acc.feed([{"index": 0, "id": "call_1", "type": "function", "function": {"name": "web_search", "arguments": ""}}])
        acc.feed([{"index": 0, "function": {"arguments": '{"query": "VW'}}])
        acc.feed([{"index": 0, "function": {"arguments": 'AP 是什么"}'}}])
        acc.feed([{"index": 1, "id": "call_2", "function": {"name": "web_fetch", "arguments": '{"url": "https://a.com"}'}}])
        calls = acc.calls()
        self.assertEqual([c["id"] for c in calls], ["call_1", "call_2"])
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]), {"query": "VWAP 是什么"})
        self.assertEqual(calls[1]["function"]["name"], "web_fetch")
        self.assertEqual(calls[0]["type"], "function")

    def test_empty_when_no_tool_calls(self):
        self.assertEqual(W.ToolCallAccumulator().calls(), [])


class RunToolTest(unittest.TestCase):
    def fake_post(self, payloads):
        seen = []

        def post(path, body):
            seen.append((path, body))
            return payloads[path]
        return post, seen

    def test_search_formats_results_and_clamps_count(self):
        post, seen = self.fake_post({"/v1/tools/search": {"results": [
            {"title": "VWAP 详解", "url": "https://x.com/vwap", "summary": "成交量加权平均价……", "site_name": "X", "date": "2026-05-01T00:00:00+00:00"},
        ]}})
        label, text = W.run_tool("web_search", '{"query": "VWAP 是什么", "count": 99}', post)
        self.assertEqual(seen[0][1]["count"], W.MAX_SEARCH_COUNT)
        self.assertEqual(seen[0][1]["query"], "VWAP 是什么")
        self.assertIn("VWAP 是什么", label)
        self.assertIn("https://x.com/vwap", text)
        self.assertIn("2026-05-01", text)
        self.assertIn("成交量加权平均价", text)

    def test_search_with_no_results_says_so(self):
        post, _ = self.fake_post({"/v1/tools/search": {"results": []}})
        _, text = W.run_tool("web_search", '{"query": "不存在的东西"}', post)
        self.assertIn("没有搜到", text)

    def test_fetch_clips_long_pages(self):
        post, seen = self.fake_post({"/v1/tools/fetch": {"title": "长文", "content": "字" * (W.MAX_FETCH_CHARS + 500)}})
        label, text = W.run_tool("web_fetch", '{"url": "https://x.com/a"}', post)
        self.assertEqual(seen[0], ("/v1/tools/fetch", {"url": "https://x.com/a"}))
        self.assertIn("https://x.com/a", label)
        self.assertIn("已截断", text)
        self.assertLess(len(text), W.MAX_FETCH_CHARS + 300)

    def test_bad_arguments_and_unknown_tool_become_messages_for_the_model(self):
        post, seen = self.fake_post({})
        self.assertIn("参数", W.run_tool("web_search", "{不是 json", post)[1])
        self.assertIn("参数", W.run_tool("web_search", '{"query": ""}', post)[1])
        self.assertIn("参数", W.run_tool("web_fetch", '{"url": "ftp://x"}', post)[1])
        self.assertIn("未知工具", W.run_tool("rm_rf", "{}", post)[1])
        self.assertEqual(seen, [])

    def test_upstream_errors_do_not_raise(self):
        def post(path, body):
            raise W.ToolError("HTTP 404：读不到这个网页")
        label, text = W.run_tool("web_fetch", '{"url": "https://x.com/gone"}', post)
        self.assertIn("失败", text)
        self.assertIn("404", text)


class EnabledTest(unittest.TestCase):
    def test_on_by_default_and_can_be_turned_off(self):
        self.assertTrue(W.enabled({}))
        self.assertTrue(W.enabled({"DEEPSEEK_WEB": "on"}))
        for v in ("off", "0", "false", "no", "OFF"):
            self.assertFalse(W.enabled({"DEEPSEEK_WEB": v}))


if __name__ == "__main__":
    unittest.main()
