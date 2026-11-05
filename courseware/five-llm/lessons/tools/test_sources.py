"""来源清单与助教资料的单元测试。不调用 DeepSeek。

运行（在课程目录下）:
    uv run --no-project python -m unittest discover -s tools -p "test_*.py"
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import serve  # noqa: E402
import sources as S  # noqa: E402


def src(id, scope="cited", aliases=(), path=None):
    return S.Source(id, id.upper(), path or f"src/{id}.ts", scope, tuple(aliases))


def reader(sizes):
    return lambda s: None if sizes.get(s.id) is None else "x" * sizes[s.id]


class SelectSources(unittest.TestCase):
    def ids(self, sel):
        return [s.id for s, _ in sel.kept]

    def test_scope_all_is_always_attached(self):
        sel = S.select_sources([src("article", "all")], "L01.html", "nothing here", reader({"article": 10}))
        self.assertEqual(self.ids(sel), ["article"])

    def test_cited_source_attached_when_alias_mentioned(self):
        sel = S.select_sources([src("state", aliases=["state.ts"])], "L01.html", "see state.ts", reader({"state": 10}))
        self.assertEqual(self.ids(sel), ["state"])

    def test_cited_source_attached_when_path_mentioned(self):
        s = src("domain", path="../../apps/x/src/domain.ts")
        sel = S.select_sources([s], "L01.html", "open apps/x/src/domain.ts", reader({"domain": 10}))
        self.assertEqual(self.ids(sel), ["domain"])

    def test_cited_source_skipped_when_not_mentioned(self):
        sel = S.select_sources([src("state", aliases=["state.ts"])], "L01.html", "no code here", reader({"state": 10}))
        self.assertEqual(self.ids(sel), [])

    def test_lesson_list_scope_attaches_to_listed_lessons(self):
        s = src("readme", scope=("L02.html",))
        self.assertEqual(self.ids(S.select_sources([s], "L02.html", "", reader({"readme": 5}))), ["readme"])

    def test_lesson_list_scope_skips_unlisted_lesson_without_mention(self):
        s = src("readme", scope=("L02.html",), aliases=["README"])
        self.assertEqual(self.ids(S.select_sources([s], "L03.html", "", reader({"readme": 5}))), [])

    def test_lesson_list_scope_still_attaches_where_cited(self):
        s = src("readme", scope=("L02.html",), aliases=["README"])
        self.assertEqual(self.ids(S.select_sources([s], "L03.html", "see README", reader({"readme": 5}))), ["readme"])

    def test_kept_order_is_all_then_by_mentions_then_listed(self):
        ss = [src("listed", scope=("L01.html",)), src("once", aliases=["one.ts"]),
              src("twice", aliases=["two.ts"]), src("article", "all")]
        sel = S.select_sources(ss, "L01.html", "two.ts one.ts two.ts", reader({k: 1 for k in ("listed", "once", "twice", "article")}))
        self.assertEqual(self.ids(sel), ["article", "twice", "once", "listed"])

    def test_over_budget_keeps_priority_and_reports_omitted(self):
        ss = [src("article", "all"), src("once", aliases=["one.ts"]), src("twice", aliases=["two.ts"])]
        sel = S.select_sources(ss, "L01.html", "two.ts one.ts two.ts", reader({"article": 50, "once": 40, "twice": 40}), budget=100)
        self.assertEqual((self.ids(sel), [s.id for s in sel.omitted]), (["article", "twice"], ["once"]))

    def test_missing_file_is_reported(self):
        sel = S.select_sources([src("article", "all")], "L01.html", "", reader({}))
        self.assertEqual([s.id for s in sel.missing], ["article"])

    def test_overlapping_aliases_count_once(self):
        s = src("state", aliases=["state.ts", "tilldone/state.ts"])
        self.assertEqual(S.mentions("tilldone/state.ts", s), 1)


class Manifest(unittest.TestCase):
    def write(self, obj):
        d = tempfile.mkdtemp()
        p = Path(d) / "sources.json"
        p.write_text(json.dumps(obj), encoding="utf-8")
        return p

    def base(self, **src):
        return {"course": {"title": "T", "prefix": "t", "port": 1, "persona": "P"},
                "sources": [{"id": "a", "label": "A", "path": "a.md", "scope": "all", **src}]}

    def test_valid_manifest_loads(self):
        course, ss = S.load_manifest(self.write(self.base(aliases=["a"])))
        self.assertEqual((course.title, ss[0].aliases), ("T", ("a",)))

    def test_bad_scope_names_the_entry(self):
        with self.assertRaisesRegex(S.ManifestError, r"sources\[0\].*scope"):
            S.load_manifest(self.write(self.base(scope="sometimes")))

    def test_duplicate_id_rejected(self):
        m = self.base()
        m["sources"].append(dict(m["sources"][0]))
        with self.assertRaisesRegex(S.ManifestError, "重复"):
            S.load_manifest(self.write(m))


class UnregisteredRefs(unittest.TestCase):
    def test_reports_file_refs_without_a_source(self):
        ss = [src("state", aliases=["state.ts"])]
        self.assertEqual(S.unregistered_refs("state.ts and domain.ts and 《某论文》", ss), ["domain.ts", "《某论文》"])

    def test_title_alias_covers_book_title(self):
        ss = [src("article", "all", aliases=["某论文"])]
        self.assertEqual(S.unregistered_refs("见《某论文》", ss), [])


def errata_answer(*objs, raw=None):
    blocks = [raw] if raw is not None else [json.dumps(o, ensure_ascii=False) for o in objs]
    return "正文。\n" + "".join(f"```errata\n{b}\n```\n" for b in blocks)


GOOD = {"lesson": "wrong.html", "section": "s1", "claim": "上限是 5 次", "evidence": "源码写的是 3 次", "source": "原文"}


class Errata(unittest.TestCase):
    def test_parses_a_valid_block_with_the_server_lesson(self):
        e = S.parse_errata(errata_answer(GOOD), "L01.html")
        self.assertEqual((len(e), e[0]["lesson"], e[0]["claim"]), (1, "L01.html", "上限是 5 次"))

    def test_ignores_bad_json(self):
        self.assertEqual(S.parse_errata(errata_answer(raw="{not json"), "L01.html"), [])

    def test_ignores_block_without_evidence(self):
        self.assertEqual(S.parse_errata(errata_answer({"claim": "x"}), "L01.html"), [])

    def test_parses_several_blocks(self):
        e = S.parse_errata(errata_answer(GOOD, {**GOOD, "claim": "另一处"}), "L01.html")
        self.assertEqual([x["claim"] for x in e], ["上限是 5 次", "另一处"])

    def test_strip_removes_blocks_and_keeps_answer(self):
        self.assertEqual(S.strip_errata(errata_answer(GOOD)), "正文。")

    def test_strip_removes_an_unfinished_block(self):
        self.assertEqual(S.strip_errata("正文。\n```errata\n{\"claim\""), "正文。")

    def test_add_dedups_by_lesson_and_claim(self):
        path = Path(tempfile.mkdtemp()) / "errata.md"
        e = S.parse_errata(errata_answer(GOOD), "L01.html")
        first = S.add_errata(path, e, "2026-11-04")
        again = S.add_errata(path, S.parse_errata(errata_answer({**GOOD, "claim": "上限是 5 次。"}), "L01.html"), "2026-11-05")
        self.assertEqual((len(first), again, len(S.read_errata(path))), (1, [], 1))

    def test_same_claim_in_another_lesson_is_new(self):
        path = Path(tempfile.mkdtemp()) / "errata.md"
        S.add_errata(path, S.parse_errata(errata_answer(GOOD), "L01.html"), "d")
        self.assertEqual(len(S.add_errata(path, S.parse_errata(errata_answer(GOOD), "L02.html"), "d")), 1)


class BuildMessages(unittest.TestCase):
    """serve.build_messages 只构建消息、不发请求：断言助教拿到了课文引用的来源。"""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        lessons = self.root / "lessons"
        (lessons / "tools").mkdir(parents=True)
        (self.root / "docs").mkdir()
        (self.root / "docs" / "article.md").write_text("ARTICLE BODY", encoding="utf-8")
        (self.root / "code").mkdir()
        (self.root / "code" / "state.ts").write_text("export const spent = 0", encoding="utf-8")
        (lessons / "L01-a.html").write_text("<main><p>讲 <code>state.ts</code></p></main>", encoding="utf-8")
        (lessons / "L02-b.html").write_text("<main><p>不讲代码</p></main>", encoding="utf-8")
        (lessons / "tools" / "sources.json").write_text(json.dumps({
            "course": {"title": "测试课", "prefix": "tc", "port": 1, "persona": "P", "rules": ["课程规则"]},
            "sources": [
                {"id": "article", "label": "原文", "path": "docs/article.md", "scope": "all"},
                {"id": "state", "label": "源码 state.ts", "path": "code/state.ts", "scope": "cited", "aliases": ["state.ts"]},
            ]}), encoding="utf-8")
        self.saved = (serve.LESSONS, serve.ROOT, serve.MANIFEST)
        serve.LESSONS, serve.ROOT, serve.MANIFEST = lessons, self.root, lessons / "tools" / "sources.json"

    def tearDown(self):
        serve.LESSONS, serve.ROOT, serve.MANIFEST = self.saved

    def system(self, lesson):
        req = {"lesson": lesson, "context": {"title": lesson}, "messages": [{"role": "user", "content": "q"}]}
        return serve.build_messages(req)[0]["content"]

    def test_lesson_citing_a_source_gets_it(self):
        self.assertIn("export const spent = 0", self.system("L01-a.html"))

    def test_attached_sources_are_listed_up_front(self):
        self.assertIn("【本课附带的资料，下面逐份给出全文】原文；源码 state.ts。", self.system("L01-a.html"))

    def test_lesson_not_citing_a_source_does_not_get_it(self):
        self.assertNotIn("export const spent = 0", self.system("L02-b.html"))

    def test_course_rules_and_title_reach_the_system_prompt(self):
        s = self.system("L02-b.html")
        self.assertTrue("测试课" in s and "8. 课程规则" in s and "ARTICLE BODY" in s)


if __name__ == "__main__":
    unittest.main()
