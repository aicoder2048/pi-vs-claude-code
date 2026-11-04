// Finalize the course: merge glossary additions, build glossary backlinks, report glossary gaps.
// Usage (from lessons/):  node tools/finalize.mjs [--merge]
//   --merge  folds assets/glossary-add-*.js into assets/glossary-data.js, removes the add files
//            and their <script> tags from lessons. Without it, only backlinks + report run.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const A = (p) => path.join(ROOT, p);
const merge = process.argv.includes("--merge");

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(A("assets/glossary-data.js"), "utf8"), ctx);
const base = Object.keys(ctx.window.CL_GLOSSARY).length;
const addFiles = fs.readdirSync(A("assets")).filter((f) => /^glossary-add-.*\.js$/.test(f)).sort();
for (const f of addFiles) {
  const before = new Set(Object.keys(ctx.window.CL_GLOSSARY));
  const snapshot = JSON.parse(JSON.stringify(ctx.window.CL_GLOSSARY));
  vm.runInContext(fs.readFileSync(A("assets/" + f), "utf8"), ctx);
  const overwritten = [...before].filter((k) => JSON.stringify(snapshot[k]) !== JSON.stringify(ctx.window.CL_GLOSSARY[k]));
  console.log(`${f}: +${Object.keys(ctx.window.CL_GLOSSARY).length - before.size} terms` + (overwritten.length ? `, OVERWROTE: ${overwritten.join(", ")}` : ""));
}
const G = ctx.window.CL_GLOSSARY;
console.log(`glossary: ${base} base + additions = ${Object.keys(G).length}`);

// scan lessons
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html") && f !== "glossary.html");
const backlinks = {};
const missing = {};
for (const p of pages) {
  const html = fs.readFileSync(A(p), "utf8");
  for (const m of html.matchAll(/href="glossary\.html#([a-z0-9-]+)"/g)) {
    const id = m[1];
    if (!G[id]) (missing[id] ||= new Set()).add(p);
    (backlinks[id] ||= new Set()).add(p);
  }
}
const order = ["index.html"]; // keep lesson order stable
const out = {};
for (const [id, set] of Object.entries(backlinks)) out[id] = [...set].filter((f) => !order.includes(f)).sort();
fs.writeFileSync(A("assets/glossary-backlinks.js"),
  "/* 自动生成 (tools/finalize.mjs)：每个术语出现在哪些课程里 */\nwindow.CL_BACKLINKS=" + JSON.stringify(out) + ";\n");
console.log(`backlinks: ${Object.keys(out).length} terms referenced`);
const unused = Object.keys(G).filter((id) => !backlinks[id] && !Object.values(G).some((t) => (t.see || []).includes(id)));
if (unused.length) console.log("terms not referenced anywhere:", unused.join(", "));
const brokenSee = Object.entries(G).flatMap(([id, t]) => (t.see || []).filter((s) => !G[s]).map((s) => `${id}->${s}`));
if (brokenSee.length) console.log("broken see-also:", brokenSee.join(", "));
if (Object.keys(missing).length) {
  console.log("MISSING terms:");
  for (const [id, s] of Object.entries(missing)) console.log(`  ${id}  (${[...s].join(", ")})`);
}

if (merge) {
  const header = "/* 共用术语表数据。glossary.html 用它生成页面；课程页用它显示悬停提示。\n" +
    " * 字段: term 中文名, en 英文, cat 分类, short 一句话 (悬停提示), body 详细解释 (HTML), see 相关术语 id\n" +
    " * 分类只用 CL_GLOSSARY_CATS 里列出的。\n" +
    " * 写法: ASD-STE100 风格 —— 短句、主动语态、一句一个意思、先说是什么再说怎么用。\n */\n";
  const body = Object.entries(G).map(([k, v]) => "  " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",").join("\n");
  fs.writeFileSync(A("assets/glossary-data.js"), header + "window.CL_GLOSSARY_CATS = " + JSON.stringify(ctx.window.CL_GLOSSARY_CATS || []) + ";\nwindow.CL_GLOSSARY = {\n" + body + "\n};\n");
  for (const p of pages) {
    const html = fs.readFileSync(A(p), "utf8");
    const cleaned = html.replace(/[ \t]*<script src="assets\/glossary-add-[^"]+\.js"><\/script>\r?\n?/g, "");
    if (cleaned !== html) fs.writeFileSync(A(p), cleaned);
  }
  for (const f of addFiles) fs.unlinkSync(A("assets/" + f));
  console.log(`merged ${addFiles.length} add files into glossary-data.js`);
}
