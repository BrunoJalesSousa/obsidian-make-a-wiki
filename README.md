# Make-a-Wiki

An Obsidian plugin for worldbuilding — give every character, item, place or faction a wiki-style infobox: a floating card with a picture, a table of facts and coloured badges, built from a small block of text in the note and edited through a form.

It's a sister plugin to [Tell-A-Tale](https://github.com/BrunoJalesSousa/obsidian-tell-a-tale): Tell-A-Tale tells the story, Make-a-Wiki keeps its wiki — and the avatar you give a character here shows up next to their dialogue there.

This is a WIP: things may change or break as it evolves. Expect some bugs here and there.

---

## Features

- **Floating infobox** — picture, heading and a table of facts, floated to the right of the note like a wiki page
- **No theme or snippet needed** — the box is styled by the plugin and follows your theme's colours, light and dark
- **Templates** — a built-in **Character** template, plus your own (Item, Location, Faction…), each with its own fields, folder, file name, tag and body sections
- **Forms** — create a new sheet or edit an existing one from a form; never touch the block unless you want to
- **Coloured badges** — per value (Female → pink, Rare → yellow) or for any value, using your theme's accent colour by default
- **Dictionary links** — kanji in a name link to their entries in a dictionary note; missing ones are flagged and can be added in one click
- **Note properties** — the image and any field can be mirrored into the note's properties, for Tell-A-Tale, Dataview, Bases or card/banner plugins
- **Safe editing** — edits go through the open editor (Ctrl+Z undoes them), target the exact block you clicked, and never drop data the form doesn't know about
- **Image paths that follow renames** — move or rename a picture and every sheet using it is updated

---

## Installation

### From Obsidian Community Plugins
Not listed yet. Until then:

### Manually
1. Download `main.js`, `styles.css` and `manifest.json` from the [latest release](https://github.com/BrunoJalesSousa/obsidian-make-a-wiki/releases)
2. Put them in `<your vault>/.obsidian/plugins/make-a-wiki/`
3. Reload Obsidian and enable **Make-a-Wiki** in **Settings → Community plugins**

---

## Quick start

1. **Ctrl+P → "Make-a-Wiki: New Character"** (or **"New sheet…"** to choose a template)
2. Fill in the form — only the first field is required — and pick an image
3. The note is created with the infobox at the top and the template's sections below it

Hover the box for the **✎ edit** button (and the image for **change image**). Everything is also available from the command palette:

| Command | What it does |
|---|---|
| New sheet… / New *Template* | Create a note from a template |
| Edit sheet in current note | Open the form for the note's sheet |
| Set sheet image | Pick the sheet's picture |
| Convert infobox callout in current note | Turn an old `> [!infobox]` callout table into a sheet |
| Convert infobox callouts in characters folder | Same, for every character note at once |

---

## What a sheet looks like in the note

The infobox is a code block named after its template. It stays readable as plain text:

````markdown
```character
image: Media/Alice/portrait.png
name: Alice Tanaka
kanji: 愛 田中
age: 17
gender: Female
birthplace: [Fictional, Japan]
languages: [Japanese, English]
tags: [Curious, Patient, Shy]
```
````

Lists are written `[a, b, c]`. Keys the template doesn't know about still show up in the box (in italics), and are kept when you save from the form.

---

## Templates

**Settings → Make-a-Wiki → Templates.** Each template has:

- **Name** and **block id** — "Item" → notes use an ` ```item ` block
- **Folder** — where new notes go
- **File name** and **title property** — patterns using field keys, e.g. `{name}` and `{name} - {kanji}`
- **Tag** — added to new notes (Tell-A-Tale finds characters by tag)
- **Infobox heading** and **body sections** (each section becomes a `###` heading in new notes)
- **Fields** — label, key and type:

| Type | Shows as |
|---|---|
| Text | plain text |
| Choice | one value; a coloured badge if it has a colour |
| Badges | a comma-separated list, each a badge |
| List | a comma-separated list, plain |
| Kanji | each kanji links to a heading in the dictionary note |
| Colour | a colour swatch (with a picker in the form) |

The ⚙ button on a field sets its **badge colours**, **form hint**, **dictionary note**, whether it's **saved as a note property**, and whether it's **hidden in the infobox**.

Renaming a field key or a block id offers to update every note that uses the template. Templates can be shared: open **Share or import this template as JSON**, copy, and paste into another vault.

---

## Working with Tell-A-Tale

Make-a-Wiki and Tell-A-Tale share character data through note properties:

| | Make-a-Wiki writes | Tell-A-Tale reads |
|---|---|---|
| Avatar | the sheet image → `avatar` (and `cover`) | the `avatar` property, when the note has no `tat-avatar-` embed |
| Dialogue colour | the Character template's hidden **Dialogue colour** field → `color` | `color` |
| Being a character | the template tag `character` | the character tag |

In Tell-A-Tale, set **Settings → Avatar property** to `avatar` (installs that predate the setting have it off). Make-a-Wiki warns you before converting an old infobox if it isn't on, and always writes to whatever property Tell-A-Tale is set to read.

---

## Settings

- **Dictionary note** — default note for Kanji fields (a field can use its own)
- **Placeholder image** — shown when a sheet has no picture (empty = built-in placeholder)
- **Image properties** — note properties that mirror the sheet image, comma-separated (default `cover, avatar`)

---

## Development

```bash
git clone https://github.com/BrunoJalesSousa/obsidian-make-a-wiki
cd obsidian-make-a-wiki
npm install

npm test          # unit + end-to-end tests (fake Obsidian API)
npm run dev       # watch mode
npm run build     # production build → main.js
```

Copy `main.js`, `styles.css` and `manifest.json` to your vault's `.obsidian/plugins/make-a-wiki/` folder.

### Releasing

Bump the version in `manifest.json`, `package.json` and `versions.json`, commit, then push a tag with the same number:

```bash
git tag 0.5.1 && git push origin 0.5.1
```

The release workflow builds the plugin and attaches `main.js`, `styles.css` and `manifest.json` to a GitHub release — which is what Obsidian installs from.
