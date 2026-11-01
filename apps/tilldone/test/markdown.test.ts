/** TillDone Desk L4 tests: assistant Markdown becomes a whitelisted node tree, never HTML. */
import { expect, test } from "bun:test";
import { markdownTree, type MdNode } from "../renderer/markdown.ts";

/** Compact form for assertions: text nodes as strings, elements as [tag, ...children]. */
function shape(nodes: MdNode[]): unknown[] {
	return nodes.map((n) => n.tag === "#text" ? n.text : [n.tag, ...(n.className ? [`.${n.className}`] : []), ...(n.text !== undefined ? [n.text] : []), ...shape(n.children ?? [])]);
}

test("paragraphs, emphasis, inline code and strikethrough", () => {
	expect(shape(markdownTree("a **b** *c* `d` ~~e~~"))).toEqual([["p", "a ", ["strong", "b"], " ", ["em", "c"], " ", ["code", "d"], " ", ["del", "e"]]]);
});
test("headings stay below the message label", () => {
	expect(shape(markdownTree("# one\n## two\n### three\n#### four"))).toEqual([["h4", "one"], ["h5", "two"], ["h6", "three"], ["h6", "four"]]);
});
test("lists keep their kind, start number and task checkboxes", () => {
	expect(shape(markdownTree("- a\n- [x] b\n- [ ] c"))).toEqual([["ul", ["li", "a"], ["li", "☑ ", "b"], ["li", "☐ ", "c"]]]);
	const ordered = markdownTree("3. x\n4. y")[0];
	expect([ordered.tag, ordered.start]).toEqual(["ol", 3]);
	expect(markdownTree("1. x")[0].start).toBeUndefined();
});
test("nested lists and loose list items keep their blocks", () => {
	expect(shape(markdownTree("- a\n  - b"))).toEqual([["ul", ["li", "a", ["ul", ["li", "b"]]]]]);
	expect(shape(markdownTree("- a\n\n- b"))).toEqual([["ul", ["li", ["p", "a"]], ["li", ["p", "b"]]]]);
});
test("code blocks, quotes and rules", () => {
	expect(shape(markdownTree("```ts\nconst a = 1 < 2;\n```\n\n> q\n\n---"))).toEqual([["pre", ["code", "const a = 1 < 2;"]], ["blockquote", ["p", "q"]], ["hr"]]);
});
test("tables carry header cells and column alignment", () => {
	expect(shape(markdownTree("| a | b |\n|:-:|--:|\n| 1 | **2** |"))).toEqual([["table",
		["thead", ["tr", ["th", ".align-center", "a"], ["th", ".align-right", "b"]]],
		["tbody", ["tr", ["td", ".align-center", "1"], ["td", ".align-right", ["strong", "2"]]]]]]);
});
test("links show their text and keep the address as a title; nothing is navigable", () => {
	const [p] = markdownTree("see [docs](https://example.com/a \"A\") and https://example.com/b");
	const links = p.children!.filter((n) => n.tag === "span");
	expect(links.map((n) => [n.className, n.title, shape(n.children!)])).toEqual([["link", "https://example.com/a", ["docs"]], ["link", "https://example.com/b", ["https://example.com/b"]]]);
});
test("images become their alt text, since the page loads no images", () => {
	expect(shape(markdownTree("![chart](x.png)"))).toEqual([["p", ["span", ".image-alt", "🖼 chart"]]]);
});
test("raw HTML and markup characters stay literal text", () => {
	expect(shape(markdownTree("<div onclick=\"x()\">hi</div>"))).toEqual([["p", "<div onclick=\"x()\">hi</div>"]]);
	expect(shape(markdownTree("a <img src=x onerror=alert(1)> & \\*b"))).toEqual([["p", "a ", "<img src=x onerror=alert(1)>", " & ", "*", "b"]]);
});
test("every element tag comes from the whitelist", () => {
	const allowed = new Set(["#text", "p", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "span"]);
	const walk = (nodes: MdNode[]): string[] => nodes.flatMap((n) => [n.tag, ...walk(n.children ?? [])]);
	const tags = walk(markdownTree("# h\n\n<script>x</script>\n\n<iframe src=x></iframe>\n\n- [x] t\n\n| a |\n|-|\n| b |\n\nline  \nbreak ![i](y) [l](javascript:alert(1))"));
	expect(tags.filter((t) => !allowed.has(t))).toEqual([]);
});
test("an unfinished stream renders what it has", () => {
	expect(shape(markdownTree("```ts\nconst a"))).toEqual([["pre", ["code", "const a"]]]);
	expect(shape(markdownTree("**bold so far"))).toEqual([["p", "**bold so far"]]);
});
