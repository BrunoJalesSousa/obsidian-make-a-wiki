// Unit tests for the pure helpers in src/main.js. Run: npm test
const Module = require("module");
const orig = Module._load;
const stub = new Proxy({}, { get: (_, k) => (k === "normalizePath" ? (p) => p : k === "parseYaml" ? () => ({}) : class {}) });
Module._load = function (r, ...a) { return r === "obsidian" ? stub : orig.call(this, r, ...a); };
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const T = require(path.join(__dirname, "../src/main.js"))._test;
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
};
// A real YAML parser, to prove what we emit round-trips.
const pyParse = (text) => yaml.load(text);

// ---- YAML emitting: tricky values must come back identical ----
const tricky = {
  plain: "Alice Tanaka", cjk: "愛 田中", comma: "14, April 1994", colon: "a: b", hash: "#tag",
  lead0: "007", sci: "1e3", trailingZero: "1.50", int: "17", yes: "yes", no: "No", nul: "null",
  dash: "- x", q: "? x", unknown: "???", quote: 'say "hi"', backslash: "C:\\x", nested: { a: 1, b: [1, 2] },
  list: ["Fictional", "Japan", "a, b", "007"], empty: "", bool: true, num: 3.5,
};
const parsed = pyParse(T.toYaml(tricky));
for (const [k, v] of Object.entries(tricky)) {
  const want = v === "" ? null : k === "int" ? 17 : v; // "17" deliberately stays a number; renders the same
  eq(`yaml roundtrip ${k}`, parsed[k], want);
}

// ---- block scanning ----
const nested = "````md\n```character\nname: fake\n```\n````\n\n```character\nname: real\n```\n";
const sc = T.scanBlocks(nested);
eq("nested fence ignored", sc.blocks.map((b) => [b.lang, b.start]), [["md", 0], ["character", 6]]);
const crlf = "---\r\ntitle: X\r\n---\r\n```character\r\nname: A\r\n```\r\ntext\r\n";
eq("crlf scan", T.scanBlocks(crlf).blocks.map((b) => [b.lang, b.start, b.end]), [["character", 3, 5]]);
eq("crlf rewrite keeps crlf", T.rewriteBlock(crlf, "character", null, () => "name: B"), crlf.replace("name: A", "name: B"));
const tilde = "~~~character\nname: T\n~~~\n";
eq("tilde fence", T.rewriteBlock(tilde, "character", null, () => "name: U"), "~~~character\nname: U\n~~~\n");

// ---- the right block is edited ----
const two = "```character\nname: First\n```\n\nmiddle\n\n```character\nname: Second\n```\n";
eq("hint picks second block", T.rewriteBlock(two, "character", 6, () => "name: Edited"), two.replace("Second", "Edited"));
eq("no hint = first block", T.rewriteBlock(two, "character", null, () => "name: Edited"), two.replace("First", "Edited"));
eq("stale hint = nearest", T.rewriteBlock(two, "character", 8, () => "name: Edited"), two.replace("Second", "Edited"));
eq("other id untouched", T.rewriteBlock(two, "item", null, () => "x: y"), two);
eq("prefix id not matched", T.scanBlocks("```character-copy\na: 1\n```").blocks[0].lang, "character-copy");

// ---- single-line edits ----
eq("setYamlLine replace", T.setYamlLine("image: a.png\nname: X", "image", "b c.png"), "image: b c.png\nname: X");
eq("setYamlLine insert", T.setYamlLine("name: X", "image", "a.png"), "image: a.png\nname: X");
eq("setYamlLine remove", T.setYamlLine("image: a.png\nname: X", "image", null), "name: X");
eq("setYamlLine keeps comments", T.setYamlLine("# note\nname: X\nimage: a", "image", "b"), "# note\nname: X\nimage: b");

// ---- frontmatter ----
eq("fm replace", T.setFrontmatterProp("---\ntitle: X\ncover: a.png\n---\nbody", "cover", "b.png"), "---\ntitle: X\ncover: b.png\n---\nbody");
eq("fm insert at end", T.setFrontmatterProp("---\ntitle: X\n---\nbody", "cover", "b.png"), "---\ntitle: X\ncover: b.png\n---\nbody");
eq("fm insert into empty", T.setFrontmatterProp("---\n---\nbody", "cover", "b.png"), "---\ncover: b.png\n---\nbody");
eq("fm create", T.setFrontmatterProp("body", "cover", "b.png"), "---\ncover: b.png\n---\nbody");
eq("fm remove", T.setFrontmatterProp("---\ntitle: X\ncover: a.png\n---\nbody", "cover", null), "---\ntitle: X\n---\nbody");
eq("fm remove last prop", T.setFrontmatterProp("---\ncover: a.png\n---\nbody", "cover", null), "---\n---\nbody");
eq("fm remove when absent", T.setFrontmatterProp("body", "cover", null), "body");
eq("fm leaves list props", T.setFrontmatterProp("---\ntags:\n  - character\n---\nb", "cover", "x.png"), "---\ntags:\n  - character\ncover: x.png\n---\nb");

// ---- migrations across notes ----
const note = "```character\nname: A\nbday: 1 May\ntags: [x]\n```\n```item\nbday: keep\n```\n";
eq("rename keys only in own blocks", T.renameKeysInBlocks(note, "character", { bday: "birthday" }), note.replace("bday: 1 May", "birthday: 1 May"));
eq("rename block id", T.renameBlockId("```thing\na: 1\n```", "thing", "item"), "```item\na: 1\n```");
eq("rename block id leaves prose", T.renameBlockId("Use ```thing blocks\n```thing\na: 1\n```", "thing", "item"), "Use ```thing blocks\n```item\na: 1\n```");

// ---- image retargeting on rename ----
const img = "---\ncover: Media/K/a.png\n---\n```character\nimage: Media/K/a.png\nname: K\n```\n```other\nimage: Media/K/a.png\n```\n";
eq("retarget full path (blocks + cover, not foreign blocks)",
  T.retargetImage(img, ["character"], ["Media/K/a.png"], "Media/K/b.png", "cover"),
  img.replace("cover: Media/K/a.png", "cover: Media/K/b.png").replace("image: Media/K/a.png\nname", "image: Media/K/b.png\nname"));
eq("retarget quoted + wikilink", T.retargetImage('```character\nimage: "[[a.png]]"\n```', ["character"], ["a.png"], "M/a 2.png", ""), "```character\nimage: M/a 2.png\n```");
eq("retarget no match unchanged", T.retargetImage(img, ["character"], ["zzz.png"], "x.png", "cover"), img);

// ---- form round trip keeps unknown + nested data ----
const base = { image: "x.png", name: "Ken", tags: ["A", "B"], gender: "Female", custom: { deep: [1, 2] }, note: "keep" };
const vals = T.dataToForm(base); vals.tags = "A, B, C"; vals.age = "17";
const data = T.formToData(T.CHARACTER_TEMPLATE.fields, vals, base);
const back = pyParse(T.toYaml(data));
eq("nested unknown survives edit", back.custom, { deep: [1, 2] });
eq("unknown scalar survives", back.note, "keep");
eq("list edited", back.tags, ["A", "B", "C"]);
eq("empty list → bare key", back.languages, null);

// ---- file names ----
eq("filename drops empty token", T.fillFileName("{name} - {kanji}", { name: "Ken Mori", kanji: "" }), "Ken Mori");
eq("filename strips illegal", T.fillFileName("{name}", { name: 'A/B: "C"?' }), "AB C");

// ---- template validation ----
const norm = (t) => T.normalizeTemplate(t);
eq("valid blank-ish", T.validateTemplate(norm({ name: "Item", id: "item", fields: [{ label: "Name", key: "name" }] }), []), null);
eq("reserved id", T.validateTemplate(norm({ name: "M", id: "mermaid" }), []) !== null, true);
eq("clash id", T.validateTemplate(norm({ name: "C2", id: "character" }), [T.CHARACTER_TEMPLATE]) !== null, true);
eq("unknown filename key", T.validateTemplate(norm({ name: "I", id: "i", fileName: "{title}" }), []) !== null, true);
eq("image key reserved", T.validateTemplate(norm({ name: "I", id: "i", fields: [{ label: "Image" }] }), []) !== null, true);
eq("unicode label → key", norm({ fields: [{ label: "名前" }] }).fields[0].key, "名前");
eq("bad type → text", norm({ fields: [{ label: "X", type: "weird" }] }).fields[0].type, "text");

// ---- settings migration ----
eq("0.2 syncCover false → no property", T.migrateSettings({ syncCover: false }).coverProperty, "");
eq("default image properties", T.migrateSettings({ syncCover: true }).coverProperty, "cover, avatar");
eq("character always present", T.migrateSettings({ templates: [{ id: "item", name: "Item", fields: [{ label: "Name" }] }] }).templates.map((t) => t.id), ["character", "item"]);

// ---- converting a callout-infobox note ----
for (const f of ["Alice Tanaka.md"]) {
  const text = fixture(f);
  const out = T.convertInfobox(text, T.CHARACTER_TEMPLATE);
  const block = out.match(/```character\n([^]*?)```/)[1];
  const y = pyParse(block);
  eq(`${f}: kanji`, typeof y.kanji, "string");
  eq(`${f}: gender`, y.gender, "Female");
  eq(`${f}: has tags`, Array.isArray(y.tags) && y.tags.length > 3, true);
  eq(`${f}: rest of note untouched`, out.split("### Background")[1], text.split("### Background")[1]);
}

// ---- note properties (Tell-A-Tale integration) ----
const tpl = T.CHARACTER_TEMPLATE;
const props = ["cover", "avatar"];
eq("new sheet: image → cover+avatar, colour → color",
  T.propertyUpdates(tpl, { image: "a.png", name: "S", color: "#e06c75" }, null, "Media/a.png", props),
  [["cover", "Media/a.png"], ["avatar", "Media/a.png"], ["color", "#e06c75"]]);
eq("no image, no colour → nothing written", T.propertyUpdates(tpl, { image: "", name: "S", color: "" }, null, "", props), []);
eq("clearing a colour the sheet had removes the property",
  T.propertyUpdates(tpl, { image: "", name: "S", color: "" }, { image: "", color: "#fff" }, "", props), [["color", null]]);
eq("a hand-set color property is never removed",
  T.propertyUpdates(tpl, { image: "", name: "S", color: "" }, { image: "", name: "S" }, "", props), []);
eq("removing the image removes cover+avatar",
  T.propertyUpdates(tpl, { image: "", name: "S" }, { image: "a.png" }, "", props), [["cover", null], ["avatar", null]]);
const fm0 = "---\ntitle: K\ncover: old.png\ntags:\n  - character\n---\nbody";
eq("apply keeps other props, appends new ones",
  T.applyProperties(fm0, [["cover", "Media/a.png"], ["avatar", "Media/a.png"], ["color", "#e06c75"]]),
  "---\ntitle: K\ncover: Media/a.png\ntags:\n  - character\navatar: Media/a.png\ncolor: \"#e06c75\"\n---\nbody");
eq("retarget updates every image property",
  T.retargetImage("---\ncover: a.png\navatar: a.png\n---\n", ["character"], ["a.png"], "M/b.png", "cover, avatar"),
  "---\ncover: M/b.png\navatar: M/b.png\n---\n");
eq("property name validation", T.validateTemplate(T.normalizeTemplate({ name: "I", id: "i", fields: [{ label: "N" }, { label: "X", property: "my prop" }] }), []) !== null, true);
eq("reserved property", T.validateTemplate(T.normalizeTemplate({ name: "I", id: "i", fields: [{ label: "N" }, { label: "X", property: "tags" }] }), []) !== null, true);
eq("character template valid", T.validateTemplate(T.normalizeTemplate(T.CHARACTER_TEMPLATE), []), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
