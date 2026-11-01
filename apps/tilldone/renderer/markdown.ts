/**
 * TillDone Desk L4: assistant Markdown as DOM, without HTML strings.
 * marked only tokenizes; every node is built from a fixed tag whitelist and filled with textContent,
 * so raw HTML stays literal text and nothing needs a sanitizer or a looser CSP.
 * Links are not navigable: the window denies navigation, and opening model-supplied URLs is not allowed.
 */
import { lexer, type Token, type Tokens } from "marked";

export type MdTag = "#text" | "p" | "h4" | "h5" | "h6" | "strong" | "em" | "del" | "code" | "pre" | "ul" | "ol" | "li"
	| "blockquote" | "hr" | "br" | "table" | "thead" | "tbody" | "tr" | "th" | "td" | "span";
export interface MdNode {
	readonly tag: MdTag;
	readonly text?: string;
	readonly children?: MdNode[];
	readonly className?: string;
	readonly title?: string;
	readonly start?: number;
}

const textNode = (text: string): MdNode => ({ tag: "#text", text });
const element = (tag: MdTag, children: MdNode[], extra: Partial<MdNode> = {}): MdNode => ({ tag, children, ...extra });
// The message label is an h3, so the reply's own headings start one level below it.
const HEADINGS: readonly MdTag[] = ["h4", "h5", "h6"];

function inline(tokens: readonly Token[] = []): MdNode[] {
	return tokens.flatMap((token): MdNode[] => {
		const t = token as Tokens.Generic;
		switch (token.type) {
			case "strong": return [element("strong", inline(t.tokens))];
			case "em": return [element("em", inline(t.tokens))];
			case "del": return [element("del", inline(t.tokens))];
			case "codespan": return [{ tag: "code", text: t.text }];
			case "br": return [element("br", [])];
			case "link": return [element("span", inline(t.tokens), { className: "link", title: t.href })];
			case "image": return [{ tag: "span", className: "image-alt", text: `🖼 ${t.text || t.href}` }];
			case "text": return t.tokens ? inline(t.tokens) : [textNode(t.text)];
			case "escape": case "html": return [textNode(t.text)];
			default: return [textNode(t.raw ?? "")];
		}
	});
}

function cells(row: readonly Tokens.TableCell[], tag: "th" | "td", align: Tokens.Table["align"]): MdNode {
	return element("tr", row.map((cell, i) => element(tag, inline(cell.tokens), align[i] ? { className: `align-${align[i]}` } : {})));
}

function blocks(tokens: readonly Token[]): MdNode[] {
	return tokens.flatMap((token): MdNode[] => {
		const t = token as Tokens.Generic;
		switch (token.type) {
			case "space": case "def": case "checkbox": return [];
			case "heading": return [element(HEADINGS[Math.min(t.depth, 3) - 1], inline(t.tokens))];
			case "paragraph": return [element("p", inline(t.tokens))];
			// A tight list item holds bare text, not a paragraph.
			case "text": return t.tokens ? inline(t.tokens) : [textNode(t.text)];
			case "code": return [element("pre", [{ tag: "code", text: t.text }])];
			case "blockquote": return [element("blockquote", blocks(t.tokens!))];
			case "hr": return [element("hr", [])];
			case "list": {
				const list = token as Tokens.List;
				const items = list.items.map((item) => element("li", [...(item.task ? [textNode(item.checked ? "☑ " : "☐ ")] : []), ...blocks(item.tokens)]));
				const start = list.ordered && typeof list.start === "number" && list.start !== 1 ? { start: list.start } : {};
				return [element(list.ordered ? "ol" : "ul", items, start)];
			}
			case "table": {
				const table = token as Tokens.Table;
				return [element("table", [element("thead", [cells(table.header, "th", table.align)]),
					element("tbody", table.rows.map((row) => cells(row, "td", table.align)))])];
			}
			// Block HTML is shown as written; it is never parsed.
			case "html": return [element("p", [textNode(t.text.replace(/\n+$/, ""))])];
			default: return t.raw ? [element("p", [textNode(t.raw)])] : [];
		}
	});
}

/** Pure: Markdown source to a whitelisted node tree. */
export function markdownTree(source: string): MdNode[] {
	return blocks(lexer(source));
}

/** Builds DOM from a node tree with createElement and textContent only. */
export function markdownFragment(nodes: readonly MdNode[]): DocumentFragment {
	const fragment = document.createDocumentFragment();
	for (const n of nodes) {
		if (n.tag === "#text") { fragment.append(n.text ?? ""); continue; }
		const el = document.createElement(n.tag);
		if (n.className) el.className = n.className;
		if (n.title) el.title = n.title;
		if (n.start !== undefined) (el as HTMLOListElement).start = n.start;
		if (n.text !== undefined) el.textContent = n.text;
		if (n.children) el.append(markdownFragment(n.children));
		fragment.append(el);
	}
	return fragment;
}
