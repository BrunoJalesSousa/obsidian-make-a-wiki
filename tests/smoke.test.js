// End-to-end smoke test against a fake Obsidian API: render → edit button → form → save through the editor.
// End-to-end test against a fake Obsidian API: render → edit button → form → save through the editor.
// Run: npm test
const Module = require("module");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const parseYaml = (s) => YAML.parse(s);

global.window = { setTimeout, confirm: () => true };
global.navigator = { clipboard: { writeText: async () => {} } };
// ---------- fake DOM ----------
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.cls = new Set(); this.text = ""; this.listeners = {}; this.title = "";
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; }
  _mk(tag, o = {}) {
    if (typeof o === "string") o = { cls: o };
    const e = new El(tag);
    if (o.cls) o.cls.split(" ").filter(Boolean).forEach((c) => e.cls.add(c));
    if (o.text != null) e.text = String(o.text);
    if (o.attr) Object.assign(e.attrs, o.attr);
    e.parent = this; this.children.push(e); return e;
  }
  createEl(t, o) { return this._mk(t, o); } createDiv(o) { return this._mk("div", o); } createSpan(o) { return this._mk("span", o); }
  setText(t) { this.text = String(t); this.children = []; } appendText(t) { this._mk("#text", { text: t }); }
  empty() { this.children = []; } addClass(c) { this.cls.add(c); } setAttrs(a) { Object.assign(this.attrs, a); } setCssProps(p) { Object.entries(p).forEach(([k, v]) => this.style.setProperty(k, v)); } setAttr(k, v) { this.attrs[k] = v; }
  addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  fire(e, evt = {}) { (this.listeners[e] || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {}, ...evt })); }
  querySelector() { return null; } focus() {} scrollIntoView() {}
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
  find(cls) { return this.all((e) => e.cls.has(cls))[0]; }
  textContent() { return this.text + this.children.map((c) => c.textContent()).join(""); }
}

// ---------- fake Obsidian ----------
class TFile { constructor(path) { this.path = path; this.name = path.split("/").pop(); this.basename = this.name.replace(/\.[^.]+$/, ""); this.extension = this.name.split(".").pop(); } }
const files = new Map();
const addFile = (path, text = "") => { const f = new TFile(path); files.set(path, { file: f, text }); return f; };
const avatar = addFile("Media/Alice/tat-avatar-AliceAvatar.png");
const newImg = addFile("Media/Alice/CharacterSheet.png");

const aliceText = fixture("Alice Tanaka.md");
let editorText; // the open editor's buffer
const notices = [];
const modals = [];

class Component { registerEvent() {} addChild(c) { c.onload?.(); return c; } }
class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
class MarkdownView { constructor(file) { this.file = file; this.editor = {
  getValue: () => editorText,
  offsetToPos: (o) => o,
  replaceRange: (txt, from, to) => { editorText = editorText.slice(0, from) + txt + editorText.slice(to); },
}; } }
class Modal {
  constructor(app) { this.app = app; this.contentEl = new El("div"); this.titleEl = new El("div"); this.modalEl = new El("div"); }
  open() { modals.push(this); this.onOpen?.(); } close() { modals.splice(modals.indexOf(this), 1); this.onClose?.(); }
}
class TextComp { constructor(parent) { this.inputEl = parent._mk("input"); this.value = ""; }
  setPlaceholder() { return this; } getValue() { return this.value; } setValue(v) { this.value = v; return this; } onChange(f) { this.cb = f; return this; } setDisabled() { return this; }
  type(v) { this.value = v; this.cb && this.cb(v); } }
class Setting {
  constructor(el) { this.settingEl = el._mk("div", "setting-item"); this.nameEl = this.settingEl._mk("div"); this.descEl = this.settingEl._mk("div"); this.controlEl = this.settingEl._mk("div"); this.texts = []; this.buttons = []; }
  setName(n) { this.nameEl.text = n; return this; } setDesc(d) { this.descEl.text = d; return this; } setClass() { return this; } setHeading() { return this; }
  addText(cb) { const t = new TextComp(this.controlEl); this.texts.push(t); cb(t); return this; }
  addTextArea(cb) { return this.addText(cb); }
  addButton(cb) { const b = { setButtonText() { return b; }, setCta() { return b; }, setIcon() { return b; }, setTooltip() { return b; }, setDisabled() { return b; }, onClick(f) { b.click = f; return b; } }; this.buttons.push(b); cb(b); return this; }
  addExtraButton(cb) { return this.addButton(cb); }
  addDropdown(cb) { const d = { addOption() { return d; }, setValue() { return d; }, onChange() { return d; } }; cb(d); return this; }
  addToggle(cb) { const t = { setValue() { return t; }, onChange() { return t; } }; cb(t); return this; }
}
const settingsSeen = [];
const OrigSetting = Setting;
const TrackedSetting = function (el) { const s = new OrigSetting(el); settingsSeen.push(s); return s; };

const app = {
  vault: {
    getAbstractFileByPath: (p) => files.get(p)?.file || null,
    getResourcePath: (f) => `app://${f.path}`,
    getFiles: () => [...files.values()].map((x) => x.file),
    getMarkdownFiles: () => [...files.values()].map((x) => x.file).filter((f) => f.extension === "md"),
    read: async (f) => files.get(f.path).text,
    cachedRead: async (f) => files.get(f.path).text,
    process: async (f, fn) => { const e = files.get(f.path); e.text = fn(e.text); return e.text; },
    create: async (p, t) => addFile(p, t), createFolder: async () => {}, on: () => ({}),
  },
  metadataCache: {
    getFileCache: (f) => (frontmatterOf[f.path] ? { frontmatter: frontmatterOf[f.path] } : null),
    getFirstLinkpathDest: (name) => [...files.values()].map((x) => x.file).find((f) => f.name === name) || null,
    on: () => ({}),
  },
  workspace: {
    getLeavesOfType: () => [{ view: openView }],
    getActiveFile: () => alice, trigger() {}, openLinkText: async () => {}, getLeaf: () => ({ openFile: async () => {} }),
  },
};
let alice, openView;
const frontmatterOf = {}; // path → parsed frontmatter, for getFileCache

const processors = {};
const commands = {};
class Plugin extends Component {
  constructor() { super(); this.app = app; }
  async loadData() { return null; } async saveData() {}
  addCommand(c) { commands[c.id] = c; } addSettingTab() {}
  registerMarkdownCodeBlockProcessor(id, f) { processors[id] = f; }
}

const rendered = []; // markdown handed to MarkdownRenderer
const MarkdownRenderer = { render: async (app, md, el) => { rendered.push(md); el._mk("a", { cls: "internal-link", text: md }); } };
const stub = {
  Plugin, MarkdownRenderer, PluginSettingTab: class {}, Setting: TrackedSetting, Modal, FuzzySuggestModal: Modal, SuggestModal: Modal,
  Notice: class { constructor(m) { notices.push(m); } }, TFile, Keymap: { isModEvent: () => false }, MarkdownView, MarkdownRenderChild,
  Platform: { isMacOS: false }, parseYaml, normalizePath: (p) => p, setIcon: () => {}, debounce: (f) => f,
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === "obsidian" ? stub : orig.call(this, r, ...a); };

// ---------- run ----------
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; if (!ok) console.log("FAIL", name, extra); };

(async () => {
  const PluginClass = require(path.join(__dirname, "../src/main.js"));
  const T = PluginClass._test;
  // Alice's note, with a second character block further down
  const converted = aliceText + "\n```character\nname: Second Block\n```\n";
  alice = addFile("Characters/Alice Tanaka.md", converted);
  editorText = converted;
  openView = new MarkdownView(alice);

  const plugin = new PluginClass();
  await plugin.onload();
  check("processor registered", typeof processors.character === "function");
  check("new-character command registered", !!commands["new-character"]);

  // render the FIRST block
  const scan = T.scanBlocks(editorText);
  const first = scan.blocks.find((b) => b.lang === "character");
  const source = scan.lines.slice(first.start + 1, first.end).join("\n");
  const el = new El("div");
  processors.character(source, el, { sourcePath: alice.path, addChild: (c) => c.onload(), getSectionInfo: () => ({ lineStart: first.start }) });
  const box = el.find("maw-infobox");
  check("box rendered", !!box, JSON.stringify(el.textContent()).slice(0, 200));
  const rows = box.all((e) => e.tag === "tr");
  check("all 13 rows rendered", rows.length === 13, `got ${rows.length}`);
  const nameRow = rows.find((r) => r.children[0].text === "Name");
  check("single Name row", nameRow && nameRow.children[1].textContent() === "Alice Tanaka" && !rows.some((r) => /Kanji|Romaji/.test(r.children[0].text)));
  const badges = box.all((e) => e.cls.has("maw-badge")).map((b) => b.text);
  check("badges", badges.includes("♀ Female") && badges.includes("🇯🇵 Japan") && badges.includes("Shy"), JSON.stringify(badges));
  check("image resolved", !!box.find("maw-image") && box.find("maw-image").attrs.src.includes("tat-avatar-AliceAvatar"));
  check("no error box", !el.find("maw-error"));

  // a visible colour field shows only the swatch (the code is in the tooltip)
  const colorField = plugin.template("character").fields.find((f) => f.key === "color");
  check("colour is off in the infobox by default", colorField.hidden === true);
  colorField.hidden = false; // as if switched on with the eye button
  const elC = new El("div");
  processors.character('name: C\ncolor: "#9fd3c7"', elC, { sourcePath: alice.path, addChild: (c) => c.onload(), getSectionInfo: () => null });
  const cRow = elC.all((e) => e.tag === "tr").find((r) => r.children[0].text === "Colour");
  const sw = cRow && cRow.children[1].children[0];
  colorField.hidden = true;
  check("colour shows swatch, not hex text", sw && sw.cls.has("maw-swatch") && sw.style.props["--maw-c"] === "#9fd3c7" && sw.attrs.title === "#9fd3c7" && cRow.children[1].textContent() === "", cRow && cRow.children[1].textContent());

  // a shown colour field keeps its row: empty or invalid → dashed swatch; block empty → the note's color property
  colorField.hidden = false;
  const kText = '---\ncolor: "#"\n---\n```character\nname: K\n```\n';
  const kFile = addFile("Characters/K.md", kText);
  frontmatterOf[kFile.path] = { color: "#" };
  const colourCell = (src, sourcePath) => {
    const e = new El("div");
    processors.character(src, e, { sourcePath, addChild: (c) => c.onload(), getSectionInfo: () => ({ lineStart: 3 }) });
    const r = e.all((x) => x.tag === "tr").find((x) => x.children[0].text === "Colour");
    return r && r.children[1].children[0];
  };
  const invalid = colourCell("name: K", kFile.path);
  check("colour row shown for an invalid property value", invalid && invalid.cls.has("maw-swatch-empty") && invalid.attrs.title === 'Not a colour: "#"', invalid && JSON.stringify(invalid.attrs));
  const none = colourCell("name: K", "Characters/Nobody.md");
  check("colour row shown with no value at all", none && none.cls.has("maw-swatch-empty") && none.attrs.title === "No colour set");
  frontmatterOf[kFile.path] = { color: "#c9a227" };
  const fromProp = colourCell("name: K", kFile.path);
  check("colour falls back to the note property", fromProp && !fromProp.cls.has("maw-swatch-empty") && fromProp.style.props["--maw-c"] === "#c9a227");
  frontmatterOf[kFile.path] = { color: "#" };

  // picking a colour where the native dialog only fires "change" still saves it to the block and the property
  await plugin.openEditor(kFile, plugin.template("character"), 3);
  const kForm = modals[modals.length - 1];
  check("form prefilled from the property", kForm && kForm.values.color === "#");
  const picker = kForm.contentEl.find("maw-color-picker");
  picker.value = "#c9a227";
  picker.fire("change");
  check("change-only picker updates the form", kForm.values.color === "#c9a227", kForm.values.color);
  await kForm.submit();
  const kSaved = files.get(kFile.path).text;
  check("picked colour saved to block and property", /```character\n[\s\S]*color: "#c9a227"\n```/.test(kSaved) && /^---\ncolor: "#c9a227"\n---/.test(kSaved), kSaved);
  colorField.hidden = true;

  // values with links go through the markdown renderer; everything else stays plain text
  const elL = new El("div");
  rendered.length = 0;
  processors.character("name: L\nage: ~2\nsexuality: \"[[Glossary#N/A|N/A]]\"\ntags: [\"[[Shy]]\", Calm]\nkanji: \"[[Jap Dictionary#克 (Katsu)|克]]\"",
    elL, { sourcePath: alice.path, addChild: (c) => c.onload(), getSectionInfo: () => null });
  check("linked values rendered as markdown", rendered.includes("[[Jap Dictionary#克 (Katsu)|克]]") && rendered.includes("[[Glossary#N/A|N/A]]"), JSON.stringify(rendered));
  check("plain values never rendered", !rendered.some((m) => m === "~2" || m === "L" || m === "Calm"), JSON.stringify(rendered));
  const lBadges = elL.all((e) => e.cls.has("maw-badge")).map((b) => b.text);
  check("badge labels show link text, not brackets", lBadges.includes("Shy") && lBadges.includes("Calm"), JSON.stringify(lBadges));

  // click ✎ → form opens with current values
  box.find("maw-edit").fire("click");
  await new Promise((r) => setTimeout(r, 20));
  const form = modals[modals.length - 1];
  check("edit form opened", form && form.constructor.name === "SheetModal");
  check("form prefilled", form.values.name === "Alice Tanaka" && form.values.tags.includes("Shy"));

  // change age + tags + image, then save
  form.values.age = "18";
  form.values.tags = "Hardworking, Studious, Stoic";
  form.values.image = newImg.path;
  form.dirty = true;
  await form.submit();
  await new Promise((r) => setTimeout(r, 20));

  const after = T.scanBlocks(editorText);
  const blocks = after.blocks.filter((b) => b.lang === "character");
  const firstData = parseYaml(after.lines.slice(blocks[0].start + 1, blocks[0].end).join("\n"));
  const secondData = parseYaml(after.lines.slice(blocks[1].start + 1, blocks[1].end).join("\n"));
  check("first block saved", firstData.age === 18 && firstData.tags.join() === "Hardworking,Studious,Stoic" && firstData.image === newImg.path, JSON.stringify(firstData));
  check("second block untouched", secondData.name === "Second Block");
  const fmAfter = editorText.split("---")[1];
  check("cover updated in frontmatter", /^cover: Media\/Alice\/CharacterSheet.png$/m.test(fmAfter), editorText.slice(0, 200));
  check("avatar property written for Tell-A-Tale", /^avatar: Media\/Alice\/CharacterSheet.png$/m.test(fmAfter), fmAfter);
  check("body text untouched", editorText.split("### Background")[1] === converted.split("### Background")[1]);
  check("saved through editor, not disk", files.get(alice.path).text === converted);
  check("notice shown", notices.some((n) => /Saved/.test(n)), JSON.stringify(notices));

  // render the SECOND block and edit it: must hit the second block only
  const s2 = T.scanBlocks(editorText).blocks.filter((b) => b.lang === "character")[1];
  const el2 = new El("div");
  processors.character("name: Second Block", el2, { sourcePath: alice.path, addChild: (c) => c.onload(), getSectionInfo: () => ({ lineStart: s2.start }) });
  el2.find("maw-edit").fire("click");
  await new Promise((r) => setTimeout(r, 20));
  const form2 = modals[modals.length - 1];
  form2.values.name = "Second Edited";
  await form2.submit();
  await new Promise((r) => setTimeout(r, 20));
  const after2 = T.scanBlocks(editorText).blocks.filter((b) => b.lang === "character");
  const d1 = parseYaml(T.scanBlocks(editorText).lines.slice(after2[0].start + 1, after2[0].end).join("\n"));
  const d2 = parseYaml(T.scanBlocks(editorText).lines.slice(after2[1].start + 1, after2[1].end).join("\n"));
  check("second edit hit second block", d2.name === "Second Edited" && d1.name === "Alice Tanaka", JSON.stringify([d1.name, d2.name]));

  // required field + new note path validation keep the form open
  const creator = new (Object.getPrototypeOf(form).constructor)(app, plugin, T.CHARACTER_TEMPLATE, {
    validate: (v) => plugin.newSheetPath(plugin.template("character"), v).error,
    onSubmit: async () => { throw new Error("should not submit"); },
  });
  creator.open();
  await creator.submit();
  check("empty name blocked", modals.includes(creator) && /required/.test(creator.errorEl.text));
  creator.values.name = "Alice Tanaka"; // Characters/Alice Tanaka.md already exists
  await creator.submit();
  check("existing path blocked", modals.includes(creator) && /already exists/.test(creator.errorEl.text), creator.errorEl.text);

  // creating a sheet for a new character
  await plugin.createSheet(plugin.template("character"), { name: "Ken Mori 森健", gender: "Male", tags: "Controlled, Sharp" });
  const created = files.get("Characters/Ken Mori 森健.md");
  check("new note created", !!created, [...files.keys()].join(" | "));
  if (created) {
    check("title = file name", /^title: Ken Mori 森健$/m.test(created.text), created.text.slice(0, 120));
    check("new note has block + sections", /```character\n/.test(created.text) && /### Visuals/.test(created.text) && /tags:\n  - character/.test(created.text));
    const nb = T.scanBlocks(created.text).blocks[0];
    const nd = parseYaml(T.scanBlocks(created.text).lines.slice(nb.start + 1, nb.end).join("\n"));
    check("new note data", nd.name === "Ken Mori 森健" && nd.tags.join() === "Controlled,Sharp" && nd.gender === "Male", JSON.stringify(nd));
    const el3 = new El("div");
    processors.character(T.scanBlocks(created.text).lines.slice(nb.start + 1, nb.end).join("\n"), el3, { sourcePath: created.file.path, addChild: (c) => c.onload(), getSectionInfo: () => null });
    check("new sheet renders kanji as text", el3.textContent().includes("Ken Mori 森健") && !el3.all((e) => e.tag === "a").length);
    check("placeholder shown", !!el3.find("maw-placeholder"));
  }

  // image rename retargets the sheet
  editorText = editorText; // keep
  files.get(alice.path).text = editorText;
  openView = new MarkdownView(addFile("Other.md", "")); // alice no longer open → disk path
  const moved = new TFile("Media/Alice/Sheet.png");
  files.delete(newImg.path); files.set(moved.path, { file: moved, text: "" });
  await plugin.onImageRenamed(moved, newImg.path);
  check("rename retargeted block + cover + avatar", ["image", "cover", "avatar"].every((k) => files.get(alice.path).text.includes(`${k}: Media/Alice/Sheet.png`)), files.get(alice.path).text.slice(0, 300));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
