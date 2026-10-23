/* Make-a-Wiki
 * Plain JavaScript (CommonJS), bundled to main.js by esbuild. Tests: npm test.
 *
 * Templates: each template defines a code block id (```character, ```item, …), its fields and badge
 * colours, the infobox heading, where new notes go, how they're named and which body sections they get.
 * "Character" is built in and can be edited but not deleted.
 *
 * Editing goes through the open editor when the note is open (so Ctrl+Z works and unsaved editor
 * changes are never overwritten), and targets the exact block that was clicked.
 */
const {
  Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, SuggestModal, Notice, TFile,
  MarkdownView, MarkdownRenderChild, Platform, parseYaml, normalizePath, setIcon, debounce,
} = require("obsidian");

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"]);
// "accent" follows the theme's accent colour (Settings → Appearance), so it changes when the user changes it.
const COLORS = ["accent", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "mono"];
// Block ids a template must not take over: real languages and other plugins' blocks.
const RESERVED_IDS = new Set([
  "js", "javascript", "ts", "typescript", "jsx", "tsx", "py", "python", "rb", "ruby", "go", "rust", "java",
  "c", "cpp", "cs", "csharp", "php", "sh", "bash", "zsh", "shell", "powershell", "sql", "json", "yaml", "yml",
  "toml", "xml", "html", "css", "scss", "md", "markdown", "diff", "text", "txt", "plain", "math", "latex",
  "tex", "mermaid", "query", "dataview", "dataviewjs", "tasks", "excalidraw", "chart", "fountain", "ad", "image",
]);

// text: plain · choice: one value, badge if it has a colour · badges: comma list, each a badge
// list: comma list, plain · color: a swatch
const FIELD_TYPES = {
  text: "Text",
  choice: "Choice (one badge)",
  badges: "Badges (list)",
  list: "List (plain)",
  color: "Colour (swatch)",
};
const MULTI = new Set(["badges", "list"]);

const CHARACTER_TEMPLATE = {
  id: "character",
  name: "Character",
  builtin: true,
  folder: "Characters",
  tag: "character",
  heading: "General Information",
  // file "Alice Tanaka.md", title "Alice Tanaka - 愛 田中"
  fileName: "{name}",
  title: "{name} - {kanji}",
  sections: ["Background", "Visuals", "Relationships"],
  fields: [
    { key: "name", label: "Name (Romaji)", type: "text" },
    { key: "kanji", label: "Name (Kanji)", type: "text" },
    { key: "race", label: "Race", type: "text" },
    { key: "age", label: "Age", type: "text" },
    { key: "birthday", label: "Birthday", type: "text", hint: "14 April 1994" },
    { key: "birthplace", label: "Place of birth", type: "badges", badges: { Japan: { color: "red", icon: "🇯🇵" } } },
    { key: "height", label: "Height", type: "text", hint: "167cm" },
    { key: "weight", label: "Weight", type: "text" },
    {
      key: "gender", label: "Gender", type: "choice",
      badges: { Female: { color: "pink", icon: "♀" }, Male: { color: "blue", icon: "♂" } },
    },
    { key: "sexuality", label: "Sexuality", type: "text" },
    { key: "occupation", label: "Occupation", type: "text" },
    { key: "blood", label: "Blood type", type: "text" },
    { key: "languages", label: "Languages", type: "list" },
    { key: "tags", label: "Tags", type: "badges", badges: { "*": { color: "accent" } } },
    // Tell-A-Tale reads `color` from the note's properties for dialogue blocks; not shown in the infobox.
    { key: "color", label: "Dialogue colour", type: "color", hint: "#e06c75", property: "color", hidden: true },
  ],
};

const BLANK_TEMPLATE = {
  id: "",
  name: "",
  folder: "",
  tag: "",
  heading: "General Information",
  fileName: "{name}",
  title: "",
  sections: ["Description"],
  fields: [{ key: "name", label: "Name", type: "text" }],
};

const DEFAULT_SETTINGS = {
  placeholderImage: "",
  // comma-separated: cover for card/banner plugins, avatar for Tell-A-Tale
  coverProperty: "cover, avatar",
  templates: [CHARACTER_TEMPLATE],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// =====================================================================================================
// Pure helpers (no Obsidian API; covered by the node tests)
// =====================================================================================================

function toItems(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

/** Block ids: ascii only (they're code-fence languages). */
function slugId(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Field keys: any letters/digits (YAML keys can be unicode), joined with _. */
function slugKey(s) {
  return String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
}

/** A full CSS colour for a badge colour name (or any CSS colour / variable passed through). */
function colorVar(color) {
  if (!color || color === "accent") return "var(--color-accent)";
  if (color === "mono") return "rgb(var(--mono-rgb-100))";
  if (/^var\(--[\w-]+-rgb\)$/.test(color)) return `rgb(${color})`; // rgb-triplet variables, as in 0.1
  if (COLORS.includes(color)) return `rgb(var(--color-${color}-rgb))`;
  return color;
}

/** Numeric-looking text that would NOT come back identical if left unquoted ("007", "1e3", "1.50"). */
function numericButNotRoundTrip(s) {
  const numeric = /^[+-]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s) || /^0[xob]/i.test(s) || /^[+-]?\.(inf|nan)$/i.test(s);
  return numeric && String(Number(s)) !== s;
}

function needsQuote(s) {
  return (
    s === "" ||
    /^\s|\s$/.test(s) ||
    /[:#\[\]{},&*!|>'"%@`\n\r\t\\]/.test(s) ||
    /^[-?](\s|$)/.test(s) ||
    /^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) ||
    numericButNotRoundTrip(s)
  );
}

function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v !== null && typeof v === "object") return JSON.stringify(v); // JSON is valid YAML flow syntax
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/** Flat YAML: scalars, arrays as flow lists, anything nested as JSON. Empty values stay as bare keys. */
function toYaml(obj) {
  return Object.entries(obj)
    .map(([k, v]) => {
      const key = needsQuote(k) ? JSON.stringify(k) : k;
      if (Array.isArray(v)) return `${key}: [${v.map(yamlScalar).join(", ")}]`;
      if (v === null || v === undefined || v === "") return `${key}:`;
      return `${key}: ${yamlScalar(v)}`;
    })
    .join("\n");
}

function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * All fenced code blocks, with line numbers. Understands ``` and ~~~, longer fences, and nesting
 * (a ```character inside a ````md example is not a real block). CRLF-safe.
 */
function scanBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open) {
      const m = l.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/);
      if (m) open = { fence: m[1], lang: m[2], start: i };
    } else {
      const m = l.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        blocks.push({ lang: open.lang, start: open.start, end: i });
        open = null;
      }
    }
  }
  return { lines, blocks };
}

/** The block of `id` at line `hint` (or the nearest one; or the first one when there's no hint). */
function locateBlock(scan, id, hint) {
  const own = scan.blocks.filter((b) => b.lang === id);
  if (!own.length) return null;
  if (hint === null || hint === undefined) return own[0];
  return own.reduce((best, b) => (Math.abs(b.start - hint) < Math.abs(best.start - hint) ? b : best));
}

function blockBody(scan, block) {
  return scan.lines.slice(block.start + 1, block.end).join("\n");
}

/** Replace a block's body. `fn(body) → newBody`. Returns the original text if the block isn't there. */
function rewriteBlock(text, id, hint, fn) {
  const scan = scanBlocks(text);
  const b = locateBlock(scan, id, hint);
  if (!b) return text;
  const body = fn(blockBody(scan, b));
  const lines = [...scan.lines.slice(0, b.start + 1), ...body.split("\n"), ...scan.lines.slice(b.end)];
  return lines.join(eolOf(text));
}

/**
 * Set (value) or remove (null) one top-level key line in a YAML body, keeping every other line as is.
 * A new key goes first (image at the top of a block) or last (`append`, for frontmatter).
 */
function setYamlLine(body, key, value, append = false) {
  const lines = body.split("\n");
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const idx = lines.findIndex((l) => re.test(l));
  if (value === null) {
    if (idx !== -1) lines.splice(idx, 1);
  } else {
    const line = `${key}: ${yamlScalar(value)}`;
    if (idx !== -1) lines[idx] = line;
    else if (append) lines[body === "" ? 0 : lines.length] = line;
    else lines.unshift(line);
  }
  return lines.join("\n");
}

/** Set (value) or remove (null) a top-level frontmatter property; creates the frontmatter if needed. */
function setFrontmatterProp(text, key, value) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (lines[0] === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l === "---");
    if (close !== -1) {
      const body = setYamlLine(lines.slice(1, close).join("\n"), key, value, true);
      const kept = body === "" ? [] : body.split("\n");
      return ["---", ...kept, ...lines.slice(close)].join(eol);
    }
  }
  if (value === null) return text;
  return ["---", `${key}: ${yamlScalar(value)}`, "---", ...lines].join(eol);
}

/** Rename top-level keys in every `id` block. renames: { old: new }. */
function renameKeysInBlocks(text, id, renames) {
  const scan = scanBlocks(text);
  const own = scan.blocks.filter((b) => b.lang === id);
  if (!own.length) return text;
  const lines = scan.lines.slice();
  for (const b of own) {
    for (let i = b.start + 1; i < b.end; i++) {
      const m = lines[i].match(/^([^\s:#][^:]*?)(\s*:.*)$/);
      if (m && Object.prototype.hasOwnProperty.call(renames, m[1])) lines[i] = renames[m[1]] + m[2];
    }
  }
  return lines.join(eolOf(text));
}

/** Rename the block id of every `oldId` fence. */
function renameBlockId(text, oldId, newId) {
  const scan = scanBlocks(text);
  const own = scan.blocks.filter((b) => b.lang === oldId);
  if (!own.length) return text;
  const lines = scan.lines.slice();
  for (const b of own) lines[b.start] = lines[b.start].replace(oldId, newId);
  return lines.join(eolOf(text));
}

/** Point image/cover values that match `oldRefs` at `newPath` in every block of `ids` and in the frontmatter. */
function retargetImage(text, ids, oldRefs, newPath, coverProperty) {
  const props = Array.isArray(coverProperty) ? coverProperty : splitProps(coverProperty);
  const matches = (raw) => {
    const v = raw.trim().replace(/^["']|["']$/g, "").replace(/^!?\[\[|\]\]$/g, "").split("|")[0].trim();
    return oldRefs.includes(v);
  };
  const scan = scanBlocks(text);
  const lines = scan.lines.slice();
  let changed = false;
  for (const b of scan.blocks.filter((x) => ids.includes(x.lang))) {
    for (let i = b.start + 1; i < b.end; i++) {
      const m = lines[i].match(/^image\s*:(.*)$/);
      if (m && matches(m[1])) {
        lines[i] = `image: ${yamlScalar(newPath)}`;
        changed = true;
      }
    }
  }
  if (props.length && lines[0] === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l === "---");
    for (const prop of props) {
      const re = new RegExp(`^${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(.*)$`);
      for (let i = 1; i < close; i++) {
        const m = lines[i].match(re);
        if (m && matches(m[1])) {
          lines[i] = `${prop}: ${yamlScalar(newPath)}`;
          changed = true;
        }
      }
    }
  }
  return changed ? lines.join(eolOf(text)) : text;
}

/** "cover, avatar" → ["cover", "avatar"] */
function splitProps(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * Note properties that mirror the sheet: the image (to every image property) and each field that has a
 * `property`. Returns [[property, value | null]] — null removes. Properties are only removed when the sheet
 * previously had a value, so hand-set properties (e.g. a `color` added before the field existed) survive.
 */
function propertyUpdates(tpl, data, oldData, imagePath, imageProps) {
  const out = [];
  const had = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
  const imageChanged = (data.image || "") !== ((oldData && oldData.image) || "");
  for (const p of imageProps) {
    if (imagePath) out.push([p, imagePath]);
    else if (imageChanged && oldData && had(oldData.image)) out.push([p, null]);
  }
  for (const f of tpl.fields) {
    if (!f.property) continue;
    const v = data[f.key];
    if (had(v)) out.push([f.property, v]);
    else if (oldData && had(oldData[f.key])) out.push([f.property, null]);
  }
  return out;
}

function applyProperties(text, updates) {
  return updates.reduce((t, [k, v]) => setFrontmatterProp(t, k, v), text);
}

/** Form values (strings) → block data, keeping any keys of `base` the form doesn't cover. */
function formToData(fields, values, base = {}) {
  const data = { image: values.image ?? base.image ?? "" };
  for (const f of fields) {
    const v = values[f.key];
    if (MULTI.has(f.type)) {
      const items = toItems(v);
      data[f.key] = items.length === 0 ? "" : items.length === 1 ? items[0] : items;
    } else {
      data[f.key] = (v ?? "").toString().trim();
    }
  }
  for (const [k, v] of Object.entries(base)) if (!(k in data)) data[k] = v;
  return data;
}

/** Block data → form values (strings). */
function dataToForm(data) {
  const values = {};
  for (const [k, v] of Object.entries(data || {})) {
    values[k] = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return values;
}

/** "{name} - {kanji}" + values → "Alice Tanaka - 愛 田中"; empty tokens drop their separators. */
function fillPattern(pattern, values) {
  let out = pattern.replace(/\{([^}]+)\}/g, (_, k) => {
    const v = values[k];
    return Array.isArray(v) ? v.join(", ") : (v ?? "").toString().trim();
  });
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s\-–—_,.]+|[\s\-–—_,.]+$/g, "");
  return out.trim();
}

/** fillPattern, minus characters that aren't allowed in file names. */
function fillFileName(pattern, values) {
  return fillPattern(pattern, values).replace(/[\\/:*?"<>|#^\[\]]/g, "").replace(/\s{2,}/g, " ").trim();
}

function patternKeys(pattern) {
  return [...String(pattern || "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** Fill in anything missing or malformed (hand-edited data.json, pasted JSON). */
function normalizeTemplate(t) {
  const out = Object.assign(clone(BLANK_TEMPLATE), t || {});
  out.id = slugId(out.id || "");
  out.name = String(out.name || "");
  out.folder = String(out.folder || "");
  out.tag = String(out.tag || "");
  out.heading = String(out.heading ?? "");
  out.fileName = String(out.fileName || "");
  out.title = String(out.title || "");
  out.sections = Array.isArray(out.sections) ? out.sections.map(String).filter(Boolean) : [];
  out.fields = (Array.isArray(out.fields) ? out.fields : [])
    .filter((f) => f && (f.key || f.label))
    .map((f) => {
      const n = { key: slugKey(f.key || f.label), label: String(f.label || f.key), type: FIELD_TYPES[f.type] ? f.type : "text" };
      if (f.badges && typeof f.badges === "object") n.badges = f.badges;
      if (f.hint) n.hint = String(f.hint);
      if (f.property) n.property = String(f.property).trim();
      if (f.hidden) n.hidden = true;
      return n;
    });
  if (!out.fields.length) out.fields = clone(BLANK_TEMPLATE.fields);
  if (out.builtin !== true) delete out.builtin;
  return out;
}

/** null if fine, otherwise a message for the user. */
function validateTemplate(t, others) {
  if (!t.name.trim()) return "The template needs a name.";
  if (!t.id) return "The template needs a block id (letters, numbers, dashes).";
  if (RESERVED_IDS.has(t.id)) return `"${t.id}" is a code language or another plugin's block. Pick another block id.`;
  const clash = others.find((o) => o.id === t.id);
  if (clash) return `Block id "${t.id}" is already used by the ${clash.name} template.`;
  if (!t.fields.length) return "The template needs at least one field.";
  for (const f of t.fields) if (!f.key) return `The field "${f.label}" needs a key.`;
  const keys = t.fields.map((f) => f.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) return `Two fields share the key "${dup}".`;
  if (keys.includes("image")) return `"image" is reserved for the picture. Rename that field's key.`;
  const props = t.fields.filter((f) => f.property).map((f) => f.property);
  for (const p of props) {
    if (!/^[^\s:#"'`\[\]{},|>&*!%@]+$/.test(p)) return `"${p}" can't be a note property name (no spaces or symbols like : # [ ]).`;
    if (["title", "tags", "aliases", "cssclasses"].includes(p)) return `"${p}" is managed by Obsidian or this plugin; pick another property name.`;
  }
  const dupProp = props.find((p, i) => props.indexOf(p) !== i);
  if (dupProp) return `Two fields write to the same property "${dupProp}".`;
  for (const [what, pattern] of [["file name", t.fileName], ["title", t.title]]) {
    const unknown = patternKeys(pattern).filter((k) => !keys.includes(k));
    if (unknown.length) return `The ${what} uses {${unknown.join("}, {")}}, which isn't a field key.`;
  }
  if (/\s/.test(t.tag)) return "Tags can't contain spaces (use - or / instead).";
  return null;
}

/** Bring older settings shapes up to date. */
function migrateSettings(saved) {
  const s = Object.assign({}, clone(DEFAULT_SETTINGS), saved || {});
  if (!Array.isArray(s.templates) || !s.templates.length) s.templates = [clone(CHARACTER_TEMPLATE)];
  // 0.1 kept character fields/badges at the top level
  if (saved && Array.isArray(saved.fields)) {
    const ch = s.templates.find((t) => t.id === "character") || s.templates[0];
    ch.fields = saved.fields.map((f) => ({ ...f, badges: saved.badges?.[f.key] || f.badges }));
    if (saved.heading !== undefined) ch.heading = saved.heading;
    if (saved.charactersFolder) ch.folder = saved.charactersFolder;
  }
  // 0.2 had a syncCover toggle instead of a property name
  if (saved && saved.syncCover === false && saved.coverProperty === undefined) s.coverProperty = "";
  for (const k of ["fields", "badges", "heading", "charactersFolder", "syncCover", "dictionaryNote"]) delete s[k];
  if (!s.templates.some((t) => t.id === "character")) s.templates.unshift(clone(CHARACTER_TEMPLATE));
  s.templates = s.templates.map((t) => normalizeTemplate(t.id === "character" ? { ...t, builtin: true } : t));
  return s;
}

// =====================================================================================================
// Plugin
// =====================================================================================================

class MakeAWikiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.boxes = new Set();
    this.registeredBlocks = new Set();
    this.settings.templates.forEach((t) => this.registerTemplate(t));

    this.addCommand({
      id: "new-sheet",
      name: "New sheet…",
      callback: () => this.pickTemplate((t) => this.openCreator(t)),
    });

    this.addCommand({
      id: "edit-sheet",
      name: "Edit sheet in current note",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) this.editFromCommand(file);
        return true;
      },
    });

    this.addCommand({
      id: "set-image",
      name: "Set sheet image",
      checkCallback: (checking) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) this.imageFromCommand(file);
        return true;
      },
    });

    // Boxes drawn before the metadata cache finished indexing can't resolve images yet; redraw
    // everything once when it's ready.
    this.cacheReady = false;
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (this.cacheReady) return;
      this.cacheReady = true;
      this.rerenderAll();
    }));

    // Image paths in blocks are plain text, so Obsidian's link updater doesn't touch them. Do it ourselves.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onImageRenamed(file, oldPath)));

    this.addSettingTab(new InfoboxSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = migrateSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.rerenderAll();
  }

  /** For text fields in the settings tab: save once typing pauses, not on every keystroke. */
  saveSettingsSoon() {
    if (!this._saveSoon) this._saveSoon = debounce(() => this.saveSettings(), 500, true);
    this._saveSoon();
  }

  rerenderAll() {
    for (const box of this.boxes) box.render();
  }

  template(id) {
    return this.settings.templates.find((t) => t.id === id);
  }

  /** Note properties that mirror the sheet image (setting "Image properties"). */
  imageProps() {
    return splitProps(this.settings.coverProperty);
  }

  /** Full vault path for an image reference (block values may be bare file names). */
  imagePath(ref, sourcePath) {
    if (!ref) return "";
    return this.resolveFile(ref, sourcePath)?.path || String(ref);
  }

  activeMarkdownFile() {
    const f = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f : null;
  }

  /** Code block processor + "New <name>" command. Obsidian can't unregister either until reload. */
  registerTemplate(t) {
    if (!t.id) return;
    const id = t.id;
    if (!this.registeredBlocks.has(id)) {
      this.registeredBlocks.add(id);
      this.registerMarkdownCodeBlockProcessor(id, (source, el, ctx) => {
        ctx.addChild(new InfoboxChild(this, el, id, source, ctx));
      });
    }
    // re-adding a command with the same id replaces it, which keeps the name in sync after a rename
    {
      this.addCommand({
        id: `new-${id}`,
        name: `New ${t.name || id}`,
        checkCallback: (checking) => {
          const tpl = this.template(id);
          if (!tpl) return false;
          if (!checking) this.openCreator(tpl);
          return true;
        },
      });
    }
  }

  pickTemplate(onChoose) {
    const list = this.settings.templates;
    if (list.length === 1) return onChoose(list[0]);
    new TemplateSuggestModal(this.app, list, onChoose).open();
  }

  // ----- reading & writing notes -----

  openView(file) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view;
    }
    return null;
  }

  /** Current text, preferring the open editor (which may hold changes not yet saved to disk). */
  async readNote(file) {
    const view = this.openView(file);
    return view ? view.editor.getValue() : this.app.vault.read(file);
  }

  /**
   * Apply `fn(text) → text`. If the note is open, edit through the editor with the smallest possible
   * change: Ctrl+Z undoes it and nothing typed but unsaved is lost. Otherwise write the file atomically.
   */
  async modifyNote(file, fn) {
    const view = this.openView(file);
    if (view) {
      const ed = view.editor;
      const old = ed.getValue();
      const neu = fn(old);
      if (neu === old) return false;
      let p = 0;
      while (p < old.length && p < neu.length && old[p] === neu[p]) p++;
      let so = old.length, sn = neu.length;
      while (so > p && sn > p && old[so - 1] === neu[sn - 1]) { so--; sn--; }
      ed.replaceRange(neu.slice(p, sn), ed.offsetToPos(p), ed.offsetToPos(so));
      return true;
    }
    let changed = false;
    await this.app.vault.process(file, (text) => {
      const neu = fn(text);
      changed = neu !== text;
      return neu;
    });
    return changed;
  }

  /** Every markdown file containing `needle`, rewritten with `fn`. Returns how many changed. */
  async rewriteVault(needle, fn) {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes(needle)) continue;
      if (await this.modifyNote(f, fn)) n++;
    }
    return n;
  }

  /** {template, data, line} of the block at `hint` (or the first sheet block in the note). */
  async loadBlock(file, tpl, hint) {
    const text = await this.readNote(file);
    const scan = scanBlocks(text);
    let block;
    if (tpl) {
      block = locateBlock(scan, tpl.id, hint);
    } else {
      block = scan.blocks.find((b) => this.template(b.lang));
      tpl = block && this.template(block.lang);
    }
    if (!block) return null;
    let data;
    try {
      data = parseYaml(blockBody(scan, block)) || {};
    } catch (e) {
      new Notice(`The ${tpl.name} block has invalid YAML, so it can't be edited with the form: ${e.message}`);
      return null;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      new Notice(`The ${tpl.name} block isn't a list of "key: value" lines.`);
      return null;
    }
    return { tpl, data, line: block.start };
  }

  // ----- rendering -----

  renderInfobox(child) {
    const { containerEl: el, sourcePath } = child;
    const tpl = this.template(child.templateId);
    el.empty();

    if (!tpl) {
      el.createDiv({ cls: "maw-error", text: `No template uses the block id "${child.templateId}" (was it deleted or renamed?).` });
      return;
    }

    let data;
    try {
      data = parseYaml(child.source) || {};
    } catch (e) {
      el.createDiv({ cls: "maw-error", text: `${tpl.name} block: invalid YAML\n${e.message}` });
      return;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      el.createDiv({ cls: "maw-error", text: `${tpl.name} block: expected "key: value" lines.` });
      return;
    }

    const box = el.createDiv({ cls: `maw-infobox maw-template-${tpl.id}` });
    // In live preview a click inside a code block widget moves the cursor in and reveals the source.
    // Swallow mousedown so the box stays rendered; raw YAML stays reachable via Obsidian's </> button.
    box.addEventListener("mousedown", (evt) => evt.stopPropagation());

    const note = this.app.vault.getAbstractFileByPath(sourcePath);
    // only markdown notes: a sheet shown inside a canvas card must not rewrite the canvas JSON
    const editable = note instanceof TFile && note.extension === "md";
    const line = () => child.ctx.getSectionInfo(el)?.lineStart ?? null;

    if (editable) {
      const edit = box.createEl("button", { cls: "maw-edit clickable-icon", attr: { "aria-label": `Edit ${tpl.name.toLowerCase()}` } });
      setIcon(edit, "pencil");
      edit.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.openEditor(note, tpl, line());
      });
    }

    const pickImage = () => {
      if (editable) new ImageSuggestModal(this.app, (img) => this.setImage(note, tpl, line(), img.path)).open();
    };
    const imgFile = this.resolveFile(data.image, sourcePath) || this.resolveFile(this.settings.placeholderImage, sourcePath);
    if (imgFile) {
      const wrap = box.createDiv({ cls: "maw-image-wrap" });
      wrap.createEl("img", {
        cls: "maw-image",
        attr: { src: this.app.vault.getResourcePath(imgFile), alt: String(data[tpl.fields[0]?.key] ?? ""), loading: "lazy" },
      });
      if (editable) {
        const change = wrap.createEl("button", { cls: "maw-image-btn clickable-icon", attr: { "aria-label": "Change image" } });
        setIcon(change, "image");
        change.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          pickImage();
        });
      }
    } else {
      const ph = box.createDiv({ cls: "maw-placeholder" });
      setIcon(ph.createDiv({ cls: "maw-placeholder-icon" }), tpl.id === "character" ? "user-round" : "image");
      ph.createDiv({ cls: "maw-placeholder-text", text: data.image ? `Image not found: ${data.image}` : editable ? "Click to set image" : "No image" });
      if (editable) {
        ph.setAttrs({ role: "button", tabindex: "0", "aria-label": "Choose an image" });
        ph.addEventListener("click", pickImage);
        ph.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); pickImage(); }
        });
      }
    }

    if (tpl.heading) box.createDiv({ cls: "maw-heading", text: tpl.heading });

    const tbody = box.createEl("table", { cls: "maw-table" }).createEl("tbody");
    const known = new Set(["image"]);
    const rows = [];
    for (const f of tpl.fields) {
      known.add(f.key);
      if (data[f.key] !== undefined && !f.hidden) rows.push([f, data[f.key]]);
    }
    for (const [k, v] of Object.entries(data)) {
      if (!known.has(k)) rows.push([{ key: k, label: k, type: "text", unknown: true }, v]);
    }

    let shown = 0;
    for (const [field, value] of rows) {
      if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
      const tr = tbody.createEl("tr", { cls: field.unknown ? "maw-unknown" : "" });
      tr.createEl("th", { text: field.label, attr: field.unknown ? { title: `"${field.key}" isn't a field of the ${tpl.name} template` } : {} });
      this.renderValue(tr.createEl("td"), field, value, sourcePath, child);
      shown++;
    }
    if (!shown && editable) {
      const empty = box.createDiv({ cls: "maw-empty", text: "No details yet — click ✎ to fill them in." });
      empty.addEventListener("click", () => this.openEditor(note, tpl, line()));
    }
  }

  renderValue(td, field, value, sourcePath, child) {
    if (field.type === "color") {
      const sw = td.createSpan({ cls: "maw-swatch" });
      sw.setCssProps({ "--maw-c": String(value) });
      td.appendText(String(value));
      return;
    }

    if (field.type === "choice") {
      const v = Array.isArray(value) ? value.join(", ") : String(value);
      const rule = this.badgeRule(field, v);
      if (rule) this.badge(td, v, rule);
      else td.setText(v);
      return;
    }

    if (MULTI.has(field.type)) {
      const items = toItems(value);
      items.forEach((item, i) => {
        const rule = field.type === "badges" ? this.badgeRule(field, item) : null;
        if (rule) this.badge(td, item, rule);
        else td.appendText(item);
        if (i < items.length - 1) td.appendText(rule ? " " : ", ");
      });
      return;
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      td.createEl("code", { text: JSON.stringify(value) });
      return;
    }
    td.setText(Array.isArray(value) ? value.join(", ") : String(value));
  }

  badge(parent, text, rule) {
    const el = parent.createSpan({ cls: "maw-badge", text: rule.icon ? `${rule.icon} ${text}` : text });
    el.setCssProps({ "--maw-c": colorVar(rule.color || "accent") });
    return el;
  }

  badgeRule(field, item) {
    const rules = field.badges;
    if (!rules) return null;
    const match = Object.keys(rules).find((k) => k !== "*" && k.toLowerCase() === item.toLowerCase());
    return match ? rules[match] : rules["*"] || null;
  }

  /** Accepts "path/to/file.png", "file.png", "[[file.png]]" or "![[file.png|alias]]". */
  resolveFile(ref, sourcePath) {
    if (!ref) return null;
    const clean = String(ref).replace(/^!?\[\[|\]\]$/g, "").split("|")[0].trim();
    if (!clean) return null;
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(clean));
    if (direct instanceof TFile) return direct;
    return this.app.metadataCache.getFirstLinkpathDest(clean, sourcePath) || null;
  }

  // ----- create / edit -----

  openCreator(tpl) {
    new SheetModal(this.app, this, tpl, {
      validate: (values) => this.newSheetPath(tpl, values).error,
      onSubmit: (values) => this.createSheet(tpl, values),
    }).open();
  }

  /** Re-reads the block from the note so the form never starts from stale data. */
  async openEditor(file, tpl, hint) {
    const loaded = await this.loadBlock(file, tpl, hint);
    if (!loaded) return;
    const first = loaded.tpl.fields[0]?.key;
    // a property-backed field that the block doesn't have yet starts from the note's property (e.g. a
    // `color` set by hand for Tell-A-Tale before the field existed)
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    for (const f of loaded.tpl.fields) {
      if (f.property && (loaded.data[f.key] === undefined || loaded.data[f.key] === "" || loaded.data[f.key] === null) && fm[f.property] != null) {
        loaded.data[f.key] = fm[f.property];
      }
    }
    new SheetModal(this.app, this, loaded.tpl, {
      title: `Edit ${(first && loaded.data[first]) || file.basename}`,
      submitText: "Save",
      initial: dataToForm(loaded.data),
      onSubmit: (values) => this.updateSheet(file, loaded.tpl, loaded.line, loaded.data, values),
    }).open();
  }

  async editFromCommand(file) {
    const loaded = await this.loadBlock(file, null, null);
    if (!loaded) return new Notice("This note has no sheet block.");
    this.openEditor(file, loaded.tpl, loaded.line);
  }

  newSheetPath(tpl, values) {
    const name = fillFileName(tpl.fileName || `{${tpl.fields[0].key}}`, values);
    if (!name) return { error: "The file name would be empty — fill in the fields it uses." };
    const folder = normalizePath(tpl.folder || "/");
    const path = normalizePath(folder === "/" ? `${name}.md` : `${folder}/${name}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) return { error: `A note already exists at ${path}.` };
    return { name, folder, path };
  }

  async createSheet(tpl, values) {
    const { name, folder, path, error } = this.newSheetPath(tpl, values);
    if (error) return new Notice(error);
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);

    const data = formToData(tpl.fields, values);
    const title = (tpl.title && fillPattern(tpl.title, values)) || name;
    const front = ["---", `title: ${yamlScalar(title)}`];
    if (tpl.tag) front.push("tags:", `  - ${yamlScalar(tpl.tag)}`);
    front.push("---");

    const body = [...front, "```" + tpl.id, toYaml(data), "```", ""];
    for (const section of tpl.sections || []) body.push("---", `### ${section}`, "", "");

    const updates = propertyUpdates(tpl, data, null, this.imagePath(data.image, path), this.imageProps());
    const file = await this.app.vault.create(path, applyProperties(body.join("\n"), updates));
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async updateSheet(file, tpl, line, oldData, values) {
    const data = formToData(tpl.fields, values, oldData);
    const updates = propertyUpdates(tpl, data, oldData, this.imagePath(data.image, file.path), this.imageProps());
    const changed = await this.modifyNote(file, (text) => applyProperties(rewriteBlock(text, tpl.id, line, () => toYaml(data)), updates));
    if (changed) new Notice(`Saved ${file.basename}`);
  }

  // ----- image -----

  async imageFromCommand(file) {
    const loaded = await this.loadBlock(file, null, null);
    if (!loaded) return new Notice("This note has no sheet block.");
    new ImageSuggestModal(this.app, (img) => this.setImage(file, loaded.tpl, loaded.line, img.path)).open();
  }

  async setImage(file, tpl, line, path) {
    const props = this.imageProps();
    await this.modifyNote(file, (text) =>
      applyProperties(rewriteBlock(text, tpl.id, line, (body) => setYamlLine(body, "image", path)), props.map((p) => [p, path]))
    );
  }

  async onImageRenamed(file, oldPath) {
    if (!(file instanceof TFile) || !IMAGE_EXT.has(file.extension.toLowerCase())) return;
    const oldName = oldPath.split("/").pop();
    // A bare file name ("CharacterSheet.png") only identified this image if the name changed and no other
    // file still carries the old name — otherwise it may belong to another note's image.
    const nameStillUsed = !!this.app.metadataCache.getFirstLinkpathDest(oldName, "");
    const oldRefs = oldName !== file.name && !nameStillUsed ? [oldPath, oldName] : [oldPath];
    const ids = this.settings.templates.map((t) => t.id);
    const n = await this.rewriteVault(oldName, (text) => retargetImage(text, ids, oldRefs, file.path, this.imageProps()));
    if (n) new Notice(`Updated the image path in ${n} sheet${n === 1 ? "" : "s"}`);
  }

  // ----- template changes that touch notes -----

  /** Apply key renames / block id changes of a template to the notes that use it. */
  async migrateNotes(oldId, newId, renames) {
    let n = 0;
    if (Object.keys(renames).length) {
      n += await this.rewriteVault("```" + oldId, (text) => renameKeysInBlocks(text, oldId, renames));
    }
    if (oldId !== newId) {
      n += await this.rewriteVault("```" + oldId, (text) => renameBlockId(text, oldId, newId));
    }
    return n;
  }
}

/** One rendered box. Owned by Obsidian's render lifecycle; we keep a registry so we can re-render it. */
class InfoboxChild extends MarkdownRenderChild {
  constructor(plugin, el, templateId, source, ctx) {
    super(el);
    this.plugin = plugin;
    this.templateId = templateId;
    this.source = source;
    this.ctx = ctx;
    this.sourcePath = ctx.sourcePath;
  }

  onload() {
    this.plugin.boxes.add(this);
    this.render();
  }

  onunload() {
    this.plugin.boxes.delete(this);
  }

  render() {
    this.plugin.renderInfobox(this);
  }
}

// =====================================================================================================
// Modals
// =====================================================================================================

function confirmModal(app, { title, body, cta = "Confirm", warning = false }) {
  return new Promise((resolve) => {
    const m = new Modal(app);
    let answered = false;
    m.titleEl.setText(title);
    m.contentEl.createEl("p", { cls: "maw-confirm-body", text: body });
    const buttons = m.contentEl.createDiv({ cls: "maw-form-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => m.close());
    const ok = buttons.createEl("button", { cls: warning ? "mod-warning" : "mod-cta", text: cta });
    ok.addEventListener("click", () => { answered = true; m.close(); });
    m.onClose = () => resolve(answered);
    m.open();
    window.setTimeout(() => ok.focus(), 0);
  });
}

/** Modal that asks before throwing away unsaved input (Esc, click outside, Cancel). */
class GuardedModal extends Modal {
  constructor(app) {
    super(app);
    this.dirty = false;
    this.done = false;
  }

  async close() {
    if (this.dirty && !this.done) {
      const discard = await confirmModal(this.app, {
        title: "Discard changes?",
        body: "You have unsaved changes in this form.",
        cta: "Discard",
        warning: true,
      });
      if (!discard) return;
    }
    super.close();
  }

  finish() {
    this.done = true;
    super.close();
  }
}

/** Create/edit form generated from a template's fields. */
class SheetModal extends GuardedModal {
  constructor(app, plugin, tpl, opts = {}) {
    super(app);
    this.plugin = plugin;
    this.tpl = tpl;
    this.opts = opts;
    this.values = Object.assign({}, opts.initial || {});
    this.inputs = [];
  }

  onOpen() {
    const { contentEl } = this;
    const editing = !!this.opts.initial;
    this.modalEl.addClass("maw-sheet-modal");
    contentEl.addClass("maw-form");
    this.titleEl.setText(this.opts.title || `New ${this.tpl.name.toLowerCase()}`);

    this.renderImageRow(contentEl.createDiv());

    this.tpl.fields.forEach((f, i) => {
      const s = new Setting(contentEl).setName(f.label);
      if (i === 0) s.nameEl.createSpan({ cls: "maw-required", text: " *" });
      if (f.hidden || f.property) {
        const where = [f.hidden ? "not shown in the infobox" : "", f.property ? `saved to the "${f.property}" property` : ""].filter(Boolean).join(", ");
        s.setDesc(where.charAt(0).toUpperCase() + where.slice(1) + ".");
      }
      if (MULTI.has(f.type)) s.setDesc("Separate several with commas.");
      s.addText((t) => {
        t.setPlaceholder(f.hint || "").setValue(this.values[f.key] ?? "");
        t.onChange((v) => {
          this.values[f.key] = v;
          this.dirty = true;
        });
        const choices = Object.keys(f.badges || {}).filter((k) => k !== "*");
        if (f.type === "choice" && choices.length) {
          const listId = `maw-dl-${this.tpl.id}-${slugId(f.key) || i}`;
          const dl = contentEl.createEl("datalist", { attr: { id: listId } });
          choices.forEach((c) => dl.createEl("option", { attr: { value: c } }));
          t.inputEl.setAttr("list", listId);
          s.setDesc(`Suggested: ${choices.join(", ")}`);
        } else if (f.type === "badges" && choices.length) {
          s.setDesc(`Separate several with commas. Coloured: ${choices.join(", ")}.`);
        }
        if (f.type === "color") {
          const picker = s.controlEl.createEl("input", { cls: "maw-color-picker", attr: { type: "color", "aria-label": `Pick ${f.label}` } });
          const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? "#" + v.slice(1).replace(/./g, "$&$&") : null);
          picker.value = hex(t.getValue()) || hex(f.hint || "") || "#888888";
          picker.addEventListener("input", () => {
            t.setValue(picker.value);
            this.values[f.key] = picker.value;
            this.dirty = true;
          });
          t.inputEl.addEventListener("input", () => { const h = hex(t.getValue()); if (h) picker.value = h; });
        }
        this.inputs.push(t.inputEl);
        if (i === 0) window.setTimeout(() => t.inputEl.focus(), 0);
        // Enter moves to the next field; Ctrl/Cmd+Enter (or Enter on the last field) saves.
        t.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key !== "Enter" || evt.isComposing) return;
          evt.preventDefault();
          const idx = this.inputs.indexOf(t.inputEl);
          if (evt.ctrlKey || evt.metaKey || idx === this.inputs.length - 1) this.submit();
          else this.inputs[idx + 1].focus();
        });
      });
    });

    const known = new Set(["image", ...this.tpl.fields.map((f) => f.key)]);
    const extra = Object.keys(this.values).filter((k) => !known.has(k));
    if (extra.length) {
      contentEl.createDiv({
        cls: "setting-item-description maw-extra",
        text: `Also in this block, kept as they are: ${extra.join(", ")}. Edit them in the block itself, or add them as fields to the ${this.tpl.name} template.`,
      });
    }

    this.errorEl = contentEl.createDiv({ cls: "maw-form-error" });
    const buttons = contentEl.createDiv({ cls: "maw-form-buttons" });
    buttons.createSpan({ cls: "maw-hint", text: `Enter: next field · ${Platform.isMacOS ? "⌘" : "Ctrl"}+Enter: save` });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons
      .createEl("button", { cls: "mod-cta", text: this.opts.submitText || (editing ? "Save" : "Create") })
      .addEventListener("click", () => this.submit());
  }

  renderImageRow(el) {
    el.empty();
    const s = new Setting(el).setName("Image");
    const path = this.values.image;
    const file = path ? this.plugin.resolveFile(path, "") : null;
    if (file) {
      s.descEl.createEl("img", { cls: "maw-form-thumb", attr: { src: this.app.vault.getResourcePath(file) } });
      s.descEl.createDiv({ text: file.path });
    } else {
      s.setDesc(path ? `Not found: ${path}` : "None — a placeholder is shown until you pick one.");
    }
    s.addButton((b) =>
      b.setButtonText(path ? "Change…" : "Choose…").onClick(() =>
        new ImageSuggestModal(this.app, (img) => {
          this.values.image = img.path;
          this.dirty = true;
          this.renderImageRow(el);
        }).open()
      )
    );
    if (path) {
      s.addExtraButton((b) =>
        b.setIcon("x").setTooltip("Remove image").onClick(() => {
          this.values.image = "";
          this.dirty = true;
          this.renderImageRow(el);
        })
      );
    }
  }

  async submit() {
    this.errorEl.setText("");
    const first = this.tpl.fields[0];
    if (first && !(this.values[first.key] || "").trim()) return this.showError(`${first.label} is required.`);
    const error = this.opts.validate?.(this.values);
    if (error) return this.showError(error);
    this.finish();
    try {
      await this.opts.onSubmit(this.values);
    } catch (e) {
      console.error("Make-a-Wiki:", e);
      new Notice(`Couldn't save: ${e.message}`, 10000);
    }
  }

  showError(msg) {
    this.errorEl.setText(msg);
    this.errorEl.scrollIntoView({ block: "nearest" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TemplateSuggestModal extends SuggestModal {
  constructor(app, templates, onChoose) {
    super(app);
    this.templates = templates;
    this.onChoose = onChoose;
    this.setPlaceholder("Which kind of sheet?");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.templates.filter((t) => t.name.toLowerCase().includes(q) || t.id.includes(q));
  }

  renderSuggestion(t, el) {
    el.createDiv({ text: t.name });
    el.createEl("small", { cls: "maw-muted", text: `${t.fields.length} fields · new notes go to ${t.folder || "the vault root"}` });
  }

  onChooseSuggestion(t) {
    this.onChoose(t);
  }
}

class ImageSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Choose an image…");
  }

  getItems() {
    return this.app.vault.getFiles().filter((f) => IMAGE_EXT.has(f.extension.toLowerCase()));
  }

  getItemText(file) {
    return file.path;
  }

  renderSuggestion(match, el) {
    el.addClass("maw-suggest");
    el.createEl("img", { cls: "maw-suggest-thumb", attr: { src: this.app.vault.getResourcePath(match.item), loading: "lazy" } });
    super.renderSuggestion(match, el.createDiv({ cls: "maw-suggest-text" }));
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

/** Edits a copy of a template. `onSave(draft, renames)`; renames = { oldKey: newKey } for existing fields. */
class TemplateEditorModal extends GuardedModal {
  constructor(app, plugin, template, onSave, isNew = false) {
    super(app);
    this.plugin = plugin;
    this.isNew = isNew;
    this.originalId = isNew ? null : template.id;
    this.draft = normalizeTemplate(clone(template));
    if (template.builtin) this.draft.builtin = true;
    // remember each existing field's key, so renames can be applied to existing notes
    if (!isNew) this.draft.fields.forEach((f) => Object.defineProperty(f, "_orig", { value: f.key, enumerable: false, writable: true }));
    this.onSave = onSave;
  }

  onOpen() {
    this.modalEl.addClass("maw-template-modal");
    this.render();
    // any input in the editor marks it dirty
    this.contentEl.addEventListener("input", () => (this.dirty = true));
    this.contentEl.addEventListener("change", () => (this.dirty = true));
  }

  render() {
    const { contentEl } = this;
    const d = this.draft;
    contentEl.empty();
    contentEl.addClass("maw-form");
    this.titleEl.setText(this.isNew ? "New template" : `Edit template: ${d.name}`);

    let idInput;
    new Setting(contentEl).setName("Name").setDesc("Shown in menus and commands, e.g. \"Item\".").addText((t) =>
      t.setValue(d.name).onChange((v) => {
        const autoId = this.isNew && (!d.id || d.id === slugId(d.name) || d.id.endsWith("-copy"));
        d.name = v;
        if (autoId) {
          d.id = slugId(v);
          idInput?.setValue(d.id);
        }
      })
    );

    new Setting(contentEl)
      .setName("Block id")
      .setDesc(
        d.builtin
          ? "The built-in character template always uses ```character."
          : "Notes contain a ```<id> block. Changing it later offers to update existing notes."
      )
      .addText((t) => {
        idInput = t;
        t.setValue(d.id).setDisabled(!!d.builtin).onChange((v) => (d.id = slugId(v)));
      });

    new Setting(contentEl).setName("Folder").setDesc("Where new notes are created. Empty = vault root.").addText((t) =>
      t.setPlaceholder("Items").setValue(d.folder).onChange((v) => (d.folder = v.trim()))
    );
    new Setting(contentEl)
      .setName("File name")
      .setDesc("Use {key} placeholders from the fields below, e.g. {name}. Empty = the first field.")
      .addText((t) => t.setPlaceholder(`{${d.fields[0]?.key || "name"}}`).setValue(d.fileName).onChange((v) => (d.fileName = v)));
    new Setting(contentEl)
      .setName("Title property")
      .setDesc("The note's `title:` frontmatter, e.g. {name} - {kanji}. Empty = same as the file name.")
      .addText((t) => t.setValue(d.title).onChange((v) => (d.title = v)));
    new Setting(contentEl).setName("Tag").setDesc("Added to new notes' tags. Empty = none.").addText((t) =>
      t.setValue(d.tag).onChange((v) => (d.tag = v.trim()))
    );
    new Setting(contentEl).setName("Infobox heading").setDesc("Small title above the table. Empty hides it.").addText((t) =>
      t.setValue(d.heading).onChange((v) => (d.heading = v))
    );
    new Setting(contentEl)
      .setName("Body sections")
      .setDesc("One per line. Each becomes a ### heading in new notes.")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setValue(d.sections.join("\n")).onChange((v) => (d.sections = v.split("\n").map((x) => x.trim()).filter(Boolean)));
      });

    contentEl.createEl("h3", { text: "Fields" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Label = what the infobox shows. Key = the name used inside the note's block. The first field is required. ⚙ sets badge colours, form hints, note properties and visibility.",
    });
    const fieldsEl = contentEl.createDiv({ cls: "maw-fields" });
    this.renderFields(fieldsEl);

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Add field").onClick(() => {
        d.fields.push({ key: "", label: "", type: "text" });
        this.dirty = true;
        this.renderFields(fieldsEl);
        fieldsEl.querySelector(".maw-field-row:last-child input")?.focus();
      })
    );

    const adv = contentEl.createEl("details", { cls: "maw-advanced" });
    adv.createEl("summary", { text: "Share or import this template as JSON" });
    adv.createEl("p", { cls: "setting-item-description", text: "Select all and copy the text below to share this template. Paste a template here and apply it to import." });
    const ta = adv.createEl("textarea", { cls: "maw-json" });
    const refreshJson = () => (ta.value = JSON.stringify(this.exportable(), null, 2));
    adv.addEventListener("toggle", refreshJson);
    const advButtons = adv.createDiv({ cls: "maw-form-buttons" });
    advButtons.createEl("button", { text: "Apply pasted JSON" }).addEventListener("click", () => {
      try {
        const parsed = normalizeTemplate(JSON.parse(ta.value));
        if (d.builtin) { parsed.id = d.id; parsed.builtin = true; }
        else if (!this.isNew) parsed.id = parsed.id || d.id;
        this.draft = parsed;
        this.dirty = true;
        this.render();
        new Notice("Template imported — review it, then Save");
      } catch (e) {
        new Notice(`That isn't valid template JSON: ${e.message}`);
      }
    });

    this.errorEl = contentEl.createDiv({ cls: "maw-form-error" });
    const buttons = contentEl.createDiv({ cls: "maw-form-buttons" });
    if (d.builtin) {
      buttons.createEl("button", { text: "Reset to default" }).addEventListener("click", async () => {
        const ok = await confirmModal(this.app, {
          title: "Reset the character template?",
          body: "Fields, badges and sections go back to the defaults. Your notes are not changed.",
          cta: "Reset",
          warning: true,
        });
        if (!ok) return;
        this.draft = normalizeTemplate(clone(CHARACTER_TEMPLATE));
        this.draft.builtin = true;
        this.dirty = true;
        this.render();
      });
    }
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => this.save());
  }

  exportable() {
    const { builtin, ...rest } = this.draft;
    return { ...rest, fields: rest.fields.map((f) => ({ ...f })) };
  }

  renderFields(el) {
    el.empty();
    const fields = this.draft.fields;
    fields.forEach((f, i) => {
      const row = new Setting(el).setClass("maw-field-row");
      let keyInput;
      row.addText((t) => {
        t.setPlaceholder("Label").setValue(f.label).onChange((v) => {
          const autoKey = !f._orig && (!f.key || f.key === slugKey(f.label));
          f.label = v;
          if (autoKey) {
            f.key = slugKey(v);
            keyInput.setValue(f.key);
          }
        });
        t.inputEl.addClass("maw-label-input");
      });
      row.addText((t) => {
        keyInput = t;
        t.setPlaceholder("key").setValue(f.key).onChange((v) => (f.key = slugKey(v)));
        t.inputEl.addClass("maw-key-input");
        if (f._orig) t.inputEl.title = `Was "${f._orig}". Renaming offers to update existing notes.`;
      });
      row.addDropdown((dd) => {
        Object.entries(FIELD_TYPES).forEach(([k, v]) => dd.addOption(k, v));
        dd.setValue(f.type).onChange((v) => {
          f.type = v;
          this.renderFields(el);
        });
      });
      row.addExtraButton((b) =>
        b.setIcon("settings").setTooltip("Field options").onClick(() =>
          new FieldOptionsModal(this.app, this.plugin, f, () => {
            this.dirty = true;
            this.renderFields(el);
          }).open()
        )
      );
      row.addExtraButton((b) =>
        b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(() => {
          [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
          this.dirty = true;
          this.renderFields(el);
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("arrow-down").setTooltip("Move down").setDisabled(i === fields.length - 1).onClick(() => {
          [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
          this.dirty = true;
          this.renderFields(el);
        })
      );
      row.addExtraButton((b) =>
        b.setIcon("trash-2").setTooltip("Remove field (existing notes keep the value)").setDisabled(fields.length === 1).onClick(() => {
          fields.splice(i, 1);
          this.dirty = true;
          this.renderFields(el);
        })
      );
      const summary = fieldSummary(f);
      if (summary) row.controlEl.createDiv({ cls: "maw-field-summary", text: summary });
    });
  }

  async save() {
    const d = this.draft;
    d.fields = d.fields.filter((f) => f.label.trim() || f.key.trim());
    d.fields.forEach((f) => {
      if (!f.key) f.key = slugKey(f.label);
      if (!f.label.trim()) f.label = f.key;
    });
    const others = this.plugin.settings.templates.filter((t) => t.id !== this.originalId);
    const error = validateTemplate(d, others);
    if (error) {
      this.errorEl.setText(error);
      this.errorEl.scrollIntoView({ block: "nearest" });
      return;
    }
    const renames = {};
    for (const f of d.fields) if (f._orig && f._orig !== f.key) renames[f._orig] = f.key;
    this.finish();
    await this.onSave(normalizeTemplate(d), renames, this.originalId);
  }

  onClose() {
    this.contentEl.empty();
  }
}

function fieldSummary(f) {
  const bits = [];
  const rules = Object.entries(f.badges || {});
  if ((f.type === "choice" || f.type === "badges") && rules.length) {
    bits.push(rules.map(([v, r]) => `${r.icon ? r.icon + " " : ""}${v === "*" ? "any" : v} → ${r.color}`).join(", "));
  }
  if (f.property) bits.push(`→ property "${f.property}"`);
  if (f.hidden) bits.push("hidden in infobox");
  if (f.hint) bits.push(`hint: ${f.hint}`);
  return bits.join(" · ");
}

/** Per-field options: form hint, note property, visibility, badge colours (choice/badges). */
class FieldOptionsModal extends Modal {
  constructor(app, plugin, field, onDone) {
    super(app);
    this.plugin = plugin;
    this.field = field;
    this.onDone = onDone;
    this.rules = Object.entries(field.badges || {}).map(([value, r]) => ({ value, color: r.color || "accent", icon: r.icon || "" }));
  }

  onOpen() {
    this.titleEl.setText(`Field: ${this.field.label || this.field.key}`);
    this.render();
  }

  render() {
    const { contentEl } = this;
    const f = this.field;
    contentEl.empty();
    contentEl.addClass("maw-form");

    new Setting(contentEl).setName("Form hint").setDesc("Grey example text shown in the empty form field.").addText((t) =>
      t.setValue(f.hint || "").onChange((v) => (f.hint = v))
    );

    new Setting(contentEl)
      .setName("Also save as note property")
      .setDesc("Copies the value into the note's properties, where other plugins (Tell-A-Tale, Dataview, Bases…) can read it. Empty = only in the infobox.")
      .addText((t) => t.setPlaceholder("e.g. color").setValue(f.property || "").onChange((v) => (f.property = v.trim())));

    new Setting(contentEl)
      .setName("Hide in infobox")
      .setDesc("Keep the field in the form (and the property) but don't show it in the box.")
      .addToggle((t) => t.setValue(!!f.hidden).onChange((v) => (f.hidden = v)));

    if (f.type === "choice" || f.type === "badges") {
      contentEl.createEl("h3", { text: "Badge colours" });
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Listed values become coloured badges and are suggested in the form. * = any other value. Values without a rule show as plain text.",
      });
      this.rules.forEach((r, i) => {
        const row = new Setting(contentEl).setClass("maw-field-row");
        let preview;
        const refresh = () => {
          preview.setText(r.icon ? `${r.icon} ${r.value || "Value"}` : r.value || "Value");
          preview.setCssProps({ "--maw-c": colorVar(r.color) });
        };
        row.addText((t) => t.setPlaceholder("Value or *").setValue(r.value).onChange((v) => { r.value = v.trim(); refresh(); }));
        row.addDropdown((dd) => {
          COLORS.forEach((c) => dd.addOption(c, c));
          dd.setValue(r.color).onChange((v) => { r.color = v; refresh(); });
        });
        row.addText((t) => {
          t.setPlaceholder("Icon").setValue(r.icon).onChange((v) => { r.icon = v; refresh(); });
          t.inputEl.addClass("maw-icon-input");
        });
        preview = row.controlEl.createSpan({ cls: "maw-badge" });
        refresh();
        row.addExtraButton((b) =>
          b.setIcon("trash-2").setTooltip("Remove").onClick(() => {
            this.rules.splice(i, 1);
            this.render();
          })
        );
      });
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Add value").onClick(() => {
          this.rules.push({ value: "", color: "accent", icon: "" });
          this.render();
        })
      );
    }

    const buttons = contentEl.createDiv({ cls: "maw-form-buttons" });
    buttons.createEl("button", { cls: "mod-cta", text: "Done" }).addEventListener("click", () => this.close());
  }

  onClose() {
    const f = this.field;
    if (f.type === "choice" || f.type === "badges") {
      const out = {};
      for (const r of this.rules) {
        if (!r.value) continue;
        out[r.value] = r.icon ? { color: r.color, icon: r.icon } : { color: r.color };
      }
      if (Object.keys(out).length) f.badges = out;
      else delete f.badges;
    }
    if (!f.hint) delete f.hint;
    if (!f.property) delete f.property;
    if (!f.hidden) delete f.hidden;
    this.contentEl.empty();
    this.onDone();
  }
}

// =====================================================================================================
// Settings
// =====================================================================================================

class InfoboxSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Templates").setHeading();
    for (const t of s.templates) {
      const row = new Setting(containerEl)
        .setName(t.name + (t.builtin ? " (built-in)" : ""))
        .setDesc(`\`\`\`${t.id} · ${t.fields.length} fields · new notes go to ${t.folder || "the vault root"}`);
      row.addButton((b) => b.setButtonText("Edit").onClick(() => this.editTemplate(t, false)));
      row.addExtraButton((b) =>
        b.setIcon("copy").setTooltip("Duplicate").onClick(() => {
          const copy = clone(t);
          delete copy.builtin;
          copy.name = `${t.name} copy`;
          copy.id = `${t.id}-copy`;
          this.editTemplate(copy, true);
        })
      );
      if (!t.builtin) {
        row.addExtraButton((b) =>
          b.setIcon("trash-2").setTooltip("Delete").onClick(async () => {
            const ok = await confirmModal(this.app, {
              title: `Delete the ${t.name} template?`,
              body: `Notes keep their \`\`\`${t.id} blocks, but they show an error until a template with that block id exists again.`,
              cta: "Delete",
              warning: true,
            });
            if (!ok) return;
            s.templates = s.templates.filter((x) => x !== t);
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }
    }
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("New template").setCta().onClick(() => this.editTemplate(clone(BLANK_TEMPLATE), true))
    );

    new Setting(containerEl).setName("Images").setHeading();
    const text = (name, desc, key, placeholder = "") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(placeholder).setValue(s[key]).onChange((v) => {
          s[key] = v.trim();
          this.plugin.saveSettingsSoon();
        })
      );
    text("Placeholder image", "Optional image shown when a sheet has none. Empty = built-in placeholder.", "placeholderImage");
    text(
      "Image properties",
      "Note properties that mirror the sheet image, comma-separated. \"avatar\" is what Tell-A-Tale shows next to dialogue (match its Avatar property setting); \"cover\" is used by card and banner plugins. Empty = don't write any.",
      "coverProperty",
      "cover, avatar"
    );
  }

  editTemplate(template, isNew) {
    const s = this.plugin.settings;
    new TemplateEditorModal(this.app, this.plugin, template, async (draft, renames, originalId) => {
      const idx = isNew ? -1 : s.templates.indexOf(template);
      if (idx === -1) s.templates.push(draft);
      else s.templates[idx] = draft;
      this.plugin.registerTemplate(draft);
      await this.plugin.saveSettings();
      this.display();

      const idChanged = !isNew && originalId && originalId !== draft.id;
      const renamed = Object.entries(renames);
      if (!idChanged && !renamed.length) return;
      const changes = [
        ...(idChanged ? [`• block id ${originalId} → ${draft.id}`] : []),
        ...renamed.map(([a, b]) => `• field key ${a} → ${b}`),
      ];
      const ok = await confirmModal(this.app, {
        title: "Update existing notes?",
        body: `You changed:\n${changes.join("\n")}\n\nUpdate every note that uses this template to match? If you don't, those notes show the old keys as extra rows${idChanged ? " and the old block id stops rendering" : ""}.`,
        cta: "Update notes",
      });
      if (!ok) return;
      const n = await this.plugin.migrateNotes(originalId || draft.id, draft.id, renames);
      new Notice(`Updated ${n} note change${n === 1 ? "" : "s"}`);
    }, isNew).open();
  }
}

module.exports = MakeAWikiPlugin;
module.exports._test = {
  toYaml, yamlScalar, scanBlocks, locateBlock, rewriteBlock, setYamlLine,
  setFrontmatterProp, renameKeysInBlocks, renameBlockId, retargetImage, formToData, dataToForm,
  fillFileName, fillPattern, normalizeTemplate, propertyUpdates, applyProperties, splitProps, validateTemplate, migrateSettings, CHARACTER_TEMPLATE, BLANK_TEMPLATE,
};
