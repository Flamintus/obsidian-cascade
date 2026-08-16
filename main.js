"use strict";

/*
 * Cascade
 * -------
 * Three functions, each of which can be turned on on its own:
 *   - indentation of the content sitting under a heading
 *   - one vertical bar per parent level, like the guides Obsidian already
 *     draws for nested lists
 *   - automatic heading numbering (1, 1.1, 1.1.1 ...)
 *
 * Two views, enabled and tuned independently: Reading (and PDF export) and
 * Editing (Live Preview and Source).
 *
 * Principle
 *   Levels and numbers are read from the Markdown SOURCE, never inferred from
 *   the rendered output. Both views call the same buildHeadingMap function on
 *   the same text, so they cannot drift apart.
 *
 *   This is also what makes the result immune to virtualization, which both
 *   views practise: walking the DOM would lose the heading serving as the
 *   anchor, and CSS counters would restart from zero while scrolling.
 *
 *   The JS only sets data-hib-* attributes. All rendering lives in
 *   styles.css.
 *
 * Applied depth
 *   heading line of level N     -> N-1 steps
 *   content under a heading N   -> N steps
 *   before the first heading    -> 0 steps
 */

const { Plugin, PluginSettingTab, Setting } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");
const { RangeSetBuilder, StateEffect } = require("@codemirror/state");

/* ==================================================================
   Translations

   Obsidian translates its own interface but exposes nothing to plugins: each
   one carries its own strings. English is the reference, any other language
   is only a tracing of it, and a missing key falls back to it.
   ================================================================== */

const LOCALES = {
	en: {
		"mode.read.name": "Reading view",
		"mode.read.desc": "Also applies to PDF export.",
		"mode.edit.name": "Editing view",
		"mode.edit.desc": "Live Preview and Source mode.",

		"enabled.name": "Enable in this view",

		"step.name": "Offset per level",
		"step.desc": "In pixels. Content under an H2 is offset by twice this value. Above 50, deeply nested tables become narrow.",

		"barWidth.name": "Bar thickness",
		"barWidth.desc": "In pixels.",

		"bleed.name": "Join between two blocks",
		"bleed.desc": "In pixels. Height of the line that connects a block to the one before it. Empty = the theme's paragraph spacing. Increase it if the bars look dotted between two paragraphs.",

		"headingBleed.name": "Join above a heading",
		"headingBleed.desc": "In pixels. The space before a heading is far wider than the one between two paragraphs, so its join has a value of its own; without it the bars break just before every heading. Empty = the theme's heading top margin.",

		"barColor.name": "Bar color",
		"barColor.desc": "A CSS color. Empty = the theme's border color, which follows light and dark mode.",

		"numbering.name": "Number headings",
		"numbering.desc": "Adds 1, 1.1, 1.1.1 before each heading, in the display only: Markdown files are never modified.",

		"numberingStart.name": "First numbered level",
		"numberingStart.desc": "The heading level that carries rank 1. At 2, the H1 at the top of a note is left unnumbered and H2s become 1, 2, 3. At 1, the H1 becomes 1 and H2s become 1.1, 1.2.",

		"numberGap.name": "Space after the number",
		"numberGap.desc": "In pixels, between the number and the heading text. In pixels rather than em, so the gap stays the same at every heading level.",

		"firstHeadingSpace.name": "Space above the first heading",
		"firstHeadingSpace.desc": "In pixels. Concerns only the heading at the top of a note, which Obsidian leaves without a margin for lack of a block before it. Empty = paragraph spacing, the value Editing view applies.",

		"tableSpace.name": "Space around a table",
		"tableSpace.desc": "In pixels, above and below. Reproduces the margin Obsidian gives tables, but placed inside the block so the bars run through it instead of stopping there. Empty = paragraph spacing, so the appearance is unchanged.",

		"listIndent.name": "List offset",
		"listIndent.desc": "In pixels, up to the bullet. Empty = the position it holds in Reading view, where the item text sits at 3ch and the bullet 0.8em before it.",

		"listSpacing.name": "Space before a list",
		"listSpacing.desc": "In pixels, above the first bullet only. Empty = the theme's paragraph spacing.",

		"listHanging.name": "Bullet hanging indent",
		"listHanging.desc": "In pixels. How far the bullet sits back from its item text, which alone carries the list offset. This hanging indent is what aligns wrapped lines under the text rather than under the bullet. Empty = 0.8em, the Reading view value."
	},

	fr: {
		"mode.read.name": "Mode Lecture",
		"mode.read.desc": "S'applique aussi à l'export PDF.",
		"mode.edit.name": "Mode Édition",
		"mode.edit.desc": "Live Preview et mode Source.",

		"enabled.name": "Activer dans ce mode",

		"step.name": "Décalage par niveau",
		"step.desc": "En pixels. Le contenu sous un H2 est décalé de deux fois cette valeur. Au-delà de 50, les tableaux profonds deviennent étroits.",

		"barWidth.name": "Épaisseur des barres",
		"barWidth.desc": "En pixels.",

		"bleed.name": "Raccord entre deux blocs",
		"bleed.desc": "En pixels. Hauteur du trait qui relie un bloc au bloc précédent. Vide = espacement des paragraphes du thème. Augmente si les barres apparaissent pointillées entre deux paragraphes.",

		"headingBleed.name": "Raccord au-dessus d'un titre",
		"headingBleed.desc": "En pixels. L'espace qui précède un titre est bien plus large que celui qui sépare deux paragraphes : son raccord lui est donc propre, sans quoi les barres se coupent juste avant chaque titre. Vide = marge supérieure des titres du thème.",

		"barColor.name": "Couleur des barres",
		"barColor.desc": "Couleur CSS. Vide = couleur de bordure du thème, qui suit le mode clair et sombre.",

		"numbering.name": "Numéroter les titres",
		"numbering.desc": "Ajoute 1, 1.1, 1.1.1 devant chaque titre, en affichage seulement : les fichiers Markdown ne sont jamais modifiés.",

		"numberingStart.name": "Premier niveau numéroté",
		"numberingStart.desc": "Niveau de titre qui porte le rang 1. Sur 2, le H1 en tête de note n'est pas numéroté et les H2 deviennent 1, 2, 3. Sur 1, le H1 devient 1 et les H2 deviennent 1.1, 1.2.",

		"numberGap.name": "Espace après le numéro",
		"numberGap.desc": "En pixels, entre le numéro et le texte du titre. En pixels et non en em, pour que l'écart reste le même à tous les niveaux de titre.",

		"firstHeadingSpace.name": "Marge au-dessus du premier titre",
		"firstHeadingSpace.desc": "En pixels. Ne concerne que le titre en tête de note, qu'Obsidian laisse sans marge faute de bloc avant lui. Vide = espacement des paragraphes, la valeur qu'applique le mode Édition.",

		"tableSpace.name": "Espace autour d'un tableau",
		"tableSpace.desc": "En pixels, au-dessus et au-dessous. Reprend la marge qu'Obsidian donne aux tableaux, mais posée à l'intérieur du bloc pour que les barres la traversent au lieu de s'y interrompre. Vide = espacement des paragraphes, donc apparence inchangée.",

		"listIndent.name": "Décalage des listes",
		"listIndent.desc": "En pixels, jusqu'à la puce. Vide = la position qu'elle occupe en mode Lecture, où le texte de l'item se tient à 3ch et la puce 0.8em avant lui.",

		"listSpacing.name": "Marge avant une liste",
		"listSpacing.desc": "En pixels, au-dessus de la première puce seulement. Vide = espacement des paragraphes du thème.",

		"listHanging.name": "Retrait de la puce",
		"listHanging.desc": "En pixels. Recul de la puce par rapport au texte de son item, qui seul porte le décalage des listes. C'est ce retrait qui aligne les lignes repliées sous le texte plutôt que sous la puce. Vide = 0.8em, la valeur du mode Lecture."
	}
};

/**
 * The set of strings matching the interface language.
 *
 * localStorage is the only source available: Obsidian writes the chosen
 * language there and exposes it nowhere else. The value is missing until a
 * choice has been made, and may carry a regional variant ("pt-BR"), hence the
 * fallback to the base language and then to English.
 *
 * It is read here only, when the module loads: changing the language calls
 * for restarting Obsidian, which the change imposes anyway.
 */
const STRINGS = (function () {
	const tag = String(window.localStorage.getItem("language") || "");
	return LOCALES[tag] || LOCALES[tag.split("-")[0]] || LOCALES.en;
})();

/** Translates a key. Falls back in turn to: language, English, raw key. */
function t(key) {
	return STRINGS[key] || LOCALES.en[key] || key;
}

/* ==================================================================
   Settings
   ================================================================== */

const DEFAULT_MODE = {
	step: 40,             // px per indentation level
	barWidth: 1,          // px
	bleed: "",            // px ; empty = auto (paragraph spacing)
	headingBleed: "",     // px ; empty = auto (heading top margin)
	barColor: "",         // CSS color ; empty = the theme's border color
	numbering: true,      // automatic heading numbering
	numberingStart: 2,    // heading level carrying the first rank
	numberGap: 8,         // px between the number and the heading text

	// Editing view only: Reading view already renders lists as blocks, so
	// these two settings have no object there.
	listIndent: "",       // px ; empty = auto (3ch - 0.8em, bullet position in Reading)
	listSpacing: "",      // px ; empty = auto (paragraph spacing)
	listHanging: "",      // px ; empty = auto (0.8em, bullet setback in Reading)

	// Reading view only: Editing already spaces its first heading, and its
	// tables sit between two adjoining lines.
	firstHeadingSpace: "", // px ; empty = auto (paragraph spacing)
	tableSpace: ""         // px ; empty = auto (paragraph spacing)
};

const DEFAULT_SETTINGS = {
	enabled: { read: true, edit: false },
	read: Object.assign({}, DEFAULT_MODE),
	edit: Object.assign({}, DEFAULT_MODE)
};

const VAR_PREFIX = { read: "--hib-", edit: "--hib-edit-" };
const NUMBERING_CLASS = { read: "hib-numbering", edit: "hib-edit-numbering" };
const VAR_SUFFIXES = [
	"step", "bar-width", "bleed", "heading-bleed", "bar-color", "number-gap",
	"list-indent", "list-spacing", "list-hanging", "first-heading-space", "table-space"
];

const DATA_ATTRS = [
	"data-hib-level",
	"data-hib-join",
	"data-hib-heading",
	"data-hib-number",
	"data-hib-list",
	"data-hib-list-start",
	"data-hib-first",
	"data-hib-table",
	"data-hib-before-table"
];
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/* Blocks that Live Preview does not render as lines: tables, callouts, math
   blocks, embedded files, remote images. No line decoration reaches them, so
   they are handled separately. */
const EMBED_SELECTOR = ":scope > .cm-embed-block, :scope > .math-block, :scope > .internal-embed, :scope > img";

/* Tells open editors that a setting has changed: nothing in the document
   moves, so no transaction would be emitted without it. */
const refreshEffect = StateEffect.define();

/* ==================================================================
   Reading the source
   ================================================================== */

/**
 * Builds, from the source text, the indentation level of every line and the
 * number of every heading line.
 *
 * Ignores headings that are not ones: lines inside a code block fenced by ```
 * or ~~~, and YAML front matter at the top of the file.
 *
 * @param {string} text the complete file contents
 * @param {number} startLevel heading level carrying the first rank (1 to 6)
 * @returns {{levels: number[], numbers: (string|null)[], headings: boolean[],
 *          joins: number[]}} indexed by line number (0-based); numbers is null
 *          outside a numbered heading line; headings marks the heading lines;
 *          joins gives the number of bars already open in the previous block,
 *          hence extendable upwards
 */
function buildHeadingMap(text, startLevel) {
	const lines = text.split("\n");
	const levels = new Array(lines.length).fill(0);
	const numbers = new Array(lines.length).fill(null);
	const headings = new Array(lines.length).fill(false);
	const joins = new Array(lines.length).fill(0);

	// A set of its own for Editing view. In Reading, a blank line produces no
	// block; in Editing it takes up height and must therefore carry its bars,
	// on pain of a line broken at every carriage return. It takes the level of
	// the last non-blank line, and the join is then computed step by step
	// rather than by skipping over the blanks.
	const editLevels = new Array(lines.length).fill(0);
	const editJoins = new Array(lines.length).fill(0);

	// List lines, and the first line of each list. In Reading, a list is a
	// block carrying its own indentation and margin; in Editing they are only
	// ordinary lines. Spotting them is what gives those two properties back,
	// and so aligns the two views.
	const lists = new Array(lines.length).fill(false);
	const listStarts = new Array(lines.length).fill(false);
	let lastFullLineWasList = false;

	// First non-blank line of the document, front matter excluded. The block
	// starting there has nothing before it: in Reading, none of Obsidian's
	// spacing rules reach it.
	let firstLine = -1;

	// Table lines, and the block preceding one.
	//
	// Obsidian sets "overflow-x: auto" inline on a table block, for horizontal
	// scrolling. A non-visible overflow also clips vertical overflow: the join
	// a table draws above its own box is therefore invisible there. It falls to
	// the previous block, which is not clipped, to reach down to it.
	const tables = new Array(lines.length).fill(false);
	const beforeTables = new Array(lines.length).fill(false);

	const counters = [0, 0, 0, 0, 0, 0, 0];   // indexes 1 to 6, slot 0 is unused
	let current = 0;        // level of the last heading encountered
	let fenceChar = "";     // ` or ~ while inside a code block, otherwise ""
	let fenceLength = 0;
	let lastLevel = -1;     // level of the previous block; -1 until there is one
	let i = 0;

	// Front matter: everything between the two --- stays at level 0.
	if (lines.length > 0 && lines[0].trim() === "---") {
		i = 1;
		while (i < lines.length && lines[i].trim() !== "---") i++;
		if (i < lines.length) i++;
	}

	for (; i < lines.length; i++) {
		const line = lines[i];
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);

		if (fenceChar !== "") {
			// Inside a code block: only a fence of the same type and at least
			// as long gets out of it. No heading is recognized until then.
			if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
				fenceChar = "";
				fenceLength = 0;
			}
			levels[i] = current;
		} else if (fence) {
			fenceChar = fence[1][0];
			fenceLength = fence[1].length;
			levels[i] = current;
		} else {
			const heading = /^(#{1,6})[ \t]/.exec(line);
			if (!heading) {
				levels[i] = current;

				// A bullet or number followed by a space. A horizontal rule
				// (---) has none, so it is not mistaken for a bullet.
				if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line)) {
					lists[i] = true;
					listStarts[i] = !lastFullLineWasList;
				} else if (/^[ \t]*\|/.test(line)) {
					tables[i] = true;
				}
			} else {
				const level = heading[1].length;
				current = level;
				levels[i] = level - 1;   // the heading line aligns on its parent
				headings[i] = true;

				// Any heading resets the deeper ranks, including a heading
				// sitting above startLevel: this is what restarts numbering
				// at 1 in every new chapter.
				for (let deeper = level + 1; deeper <= 6; deeper++) counters[deeper] = 0;

				if (level >= startLevel) {
					// Skipped level (an H4 right after an H2): the missing
					// rank opens at 1 rather than displaying a zero.
					for (let above = startLevel; above < level; above++) {
						if (counters[above] === 0) counters[above] = 1;
					}
					counters[level] += 1;
					numbers[i] = counters.slice(startLevel, level + 1).join(".");
				}
			}
		}

		// Bars extendable upwards: those the previous block was already
		// drawing. A heading opens a new, deeper one, which has no reason to
		// climb above it — that one has to start at its own height, just as it
		// would start at the first paragraph of an ordinary section.
		joins[i] = lastLevel < 0 ? 0 : Math.min(levels[i], lastLevel);

		const blank = line.trim() === "";
		editLevels[i] = blank ? Math.max(lastLevel, 0) : levels[i];
		editJoins[i] = i === 0 ? 0 : Math.min(editLevels[i], editLevels[i - 1]);

		// A blank line separates two blocks without making one. That is also
		// why it does not break a list: a blank line between two bullets does
		// not open a second list, in Markdown as on screen.
		if (!blank) {
			if (firstLine < 0) firstLine = i;
			lastLevel = levels[i];
			lastFullLineWasList = lists[i];
		}
	}

	// Second pass: spot the block preceding each table. The mark goes on its
	// first line, the one identifying the block in the rendered output.
	let openBlock = -1;    // first line of the current block, -1 between two blocks
	let lastBlock = -1;    // first line of the previous block
	for (let k = 0; k < lines.length; k++) {
		if (lines[k].trim() === "") {
			if (openBlock >= 0) {
				lastBlock = openBlock;
				openBlock = -1;
			}
			continue;
		}
		if (openBlock >= 0) continue;   // continuation of the current block

		if (tables[k] && lastBlock >= 0 && !tables[lastBlock]) beforeTables[lastBlock] = true;
		openBlock = k;
	}

	return {
		levels, numbers, headings, joins,
		editLevels, editJoins,
		lists, listStarts,
		tables, beforeTables,
		firstLine
	};
}

/**
 * A block's attributes, from the map and the index of its first line.
 *
 * The number is set even when numbering is off: a class on <body> is what
 * commands its display. Toggling the setting thus stays immediate, with no
 * re-render of the open notes.
 */
function attrsForLine(map, index, mode) {
	const source = mode === "edit"
		? { levels: map.editLevels, joins: map.editJoins }
		: { levels: map.levels, joins: map.joins };

	const level = Math.min(Math.max(source.levels[index] || 0, 0), 6);
	const join = Math.min(Math.max(source.joins[index] || 0, 0), 6);
	const attributes = {
		"data-hib-level": String(level),
		"data-hib-join": String(join),
		"data-hib-heading": map.headings[index] === true ? "1" : "0"
	};
	if (map.numbers[index]) attributes["data-hib-number"] = map.numbers[index];

	// Reading view has no need for these: Obsidian already renders lists there
	// as blocks, with their indentation and their margin.
	if (mode === "edit") {
		if (map.lists[index]) attributes["data-hib-list"] = "1";
		if (map.listStarts[index]) attributes["data-hib-list-start"] = "1";
	}

	// Conversely, Editing already spaces its first heading: Obsidian's rule
	// holds there for every heading line, with no condition on what comes
	// before it.
	if (mode === "read") {
		if (index === map.firstLine) attributes["data-hib-first"] = "1";

		// Editing has no need for this: its table is a single block, sitting
		// between two adjoining lines, with no margin to cross.
		if (map.tables[index]) attributes["data-hib-table"] = "1";
		if (map.beforeTables[index]) attributes["data-hib-before-table"] = "1";
	}

	return attributes;
}

/* ==================================================================
   Editing view — CodeMirror extension
   ================================================================== */

/**
 * Sets the same attributes as Reading view on the visible lines, through line
 * decorations, and on the blocks Live Preview does not render as lines.
 *
 * The map is computed over the whole document — the only way to know the
 * current heading of a visible line whose anchor is off screen — but the
 * decorations are only set on the viewport.
 */
function createEditorExtension(plugin) {
	return ViewPlugin.fromClass(
		class {
			constructor(view) {
				this.cachedDoc = null;
				this.cachedStart = null;
				this.cachedMap = null;
				this.decorations = this.build(view);
				this.syncBlocks(view);
			}

			update(update) {
				const refreshed = update.transactions.some((tr) =>
					tr.effects.some((effect) => effect.is(refreshEffect))
				);
				if (update.docChanged || update.viewportChanged || refreshed) {
					this.decorations = this.build(update.view);
					this.syncBlocks(update.view);
				}
			}

			map(state) {
				const start = plugin.settings.edit.numberingStart;
				if (this.cachedDoc !== state.doc || this.cachedStart !== start) {
					this.cachedDoc = state.doc;
					this.cachedStart = start;
					this.cachedMap = buildHeadingMap(state.doc.toString(), start);
				}
				return this.cachedMap;
			}

			build(view) {
				if (!plugin.settings.enabled.edit) return Decoration.none;

				const map = this.map(view.state);
				const builder = new RangeSetBuilder();

				for (const range of view.visibleRanges) {
					let pos = range.from;
					while (pos <= range.to) {
						const line = view.state.doc.lineAt(pos);
						builder.add(
							line.from,
							line.from,
							Decoration.line({ attributes: attrsForLine(map, line.number - 1, "edit") })
						);
						if (line.to >= view.state.doc.length) break;
						pos = line.to + 1;
					}
				}

				return builder.finish();
			}

			/**
			 * Tables, callouts, math blocks and images are blocks of their
			 * own, direct children of the container rather than lines: the
			 * decorations do not reach them. The same attributes are set on
			 * them by hand, by way of their position in the document.
			 *
			 * The write is deferred through requestMeasure: the DOM is not up
			 * to date yet at update time.
			 */
			syncBlocks(view) {
				view.requestMeasure({
					read: () => null,
					write: (_measure, measuredView) => {
						const blocks = measuredView.contentDOM.querySelectorAll(EMBED_SELECTOR);
						if (!blocks.length) return;

						if (!plugin.settings.enabled.edit) {
							for (const block of Array.from(blocks)) clearBlockAttributes(block);
							return;
						}

						const map = this.map(measuredView.state);

						for (const block of Array.from(blocks)) {
							let position;
							try {
								position = measuredView.posAtDOM(block);
							} catch (error) {
								continue;   // block detached between update and measure
							}
							const index = measuredView.state.doc.lineAt(position).number - 1;
							syncBlockAttributes(block, attrsForLine(map, index, "edit"));
						}
					}
				});
			}
		},
		{ decorations: (value) => value.decorations }
	);
}

/* ==================================================================
   Plugin
   ================================================================== */

class HeadingIndentBars extends Plugin {
	async onload() {
		this.settings = migrateSettings(await this.loadData());
		this.applyCssVariables();
		this.addSettingTab(new HeadingIndentBarsSettingTab(this.app, this));

		// One-entry cache: getSectionInfo returns the same string instance for
		// every section of a single render, so the comparison is a reference
		// equality.
		this.cachedText = null;
		this.cachedStart = null;
		this.cachedMap = null;

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.enabled.read) return;

			const info = ctx.getSectionInfo(el);
			if (!info) return;   // block with no origin in the file (inline heading, embed)

			const map = this.getReadMap(info.text);
			if (typeof map.levels[info.lineStart] !== "number") return;

			this.tagBlock(el, attrsForLine(map, info.lineStart, "read"));
		});

		this.registerEditorExtension(createEditorExtension(this));
	}

	onunload() {
		for (const mode of Object.keys(VAR_PREFIX)) {
			for (const suffix of VAR_SUFFIXES) {
				document.body.style.removeProperty(VAR_PREFIX[mode] + suffix);
			}
			document.body.classList.remove(NUMBERING_CLASS[mode]);
		}
		clearAttributes(document);
	}

	getReadMap(text) {
		const start = this.settings.read.numberingStart;
		if (this.cachedText !== text || this.cachedStart !== start) {
			this.cachedText = text;
			this.cachedStart = start;
			this.cachedMap = buildHeadingMap(text, start);
		}
		return this.cachedMap;
	}

	/**
	 * Marks the Reading view block.
	 *
	 * The element the post-processor receives is sometimes re-wrapped by
	 * Obsidian in the <div class="el-..."> that will actually carry the
	 * block's geometry. The attributes are then carried over to that ancestor,
	 * failing which the indentation would apply to an inner box. They are
	 * removed from the original element to avoid an offset applied twice.
	 *
	 * The number goes on the <hN> itself, so as to sit inside its text.
	 */
	tagBlock(el, attributes) {
		const number = attributes["data-hib-number"];
		const blockAttributes = Object.assign({}, attributes);
		delete blockAttributes["data-hib-number"];

		applyAttributes(el, blockAttributes);

		const heading = el.matches(HEADING_SELECTOR) ? el : el.querySelector(HEADING_SELECTOR);
		if (heading) {
			if (number) heading.setAttribute("data-hib-number", number);
			else heading.removeAttribute("data-hib-number");
		}

		requestAnimationFrame(() => {
			const section = el.closest(".markdown-preview-section");
			if (!section) return;   // not inserted yet: the attributes stay on el

			let host = el;
			while (host.parentElement && host.parentElement !== section) {
				host = host.parentElement;
			}
			if (host !== el && host.parentElement === section) {
				applyAttributes(host, blockAttributes);
				for (const name of DATA_ATTRS) el.removeAttribute(name);
			}
		});
	}

	applyCssVariables() {
		for (const mode of Object.keys(VAR_PREFIX)) {
			const prefix = VAR_PREFIX[mode];
			const settings = this.settings[mode];
			const style = document.body.style;

			style.setProperty(`${prefix}step`, `${settings.step}px`);
			style.setProperty(`${prefix}bar-width`, `${settings.barWidth}px`);
			style.setProperty(`${prefix}number-gap`, `${settings.numberGap}px`);
			setOrClear(style, `${prefix}bleed`, settings.bleed, "px");
			setOrClear(style, `${prefix}heading-bleed`, settings.headingBleed, "px");
			setOrClear(style, `${prefix}bar-color`, settings.barColor, "");
			setOrClear(style, `${prefix}list-indent`, settings.listIndent, "px");
			setOrClear(style, `${prefix}list-spacing`, settings.listSpacing, "px");
			setOrClear(style, `${prefix}list-hanging`, settings.listHanging, "px");
			setOrClear(style, `${prefix}first-heading-space`, settings.firstHeadingSpace, "px");
			setOrClear(style, `${prefix}table-space`, settings.tableSpace, "px");

			document.body.classList.toggle(
				NUMBERING_CLASS[mode],
				this.settings.enabled[mode] && settings.numbering
			);
		}
	}

	/** Recomputes the open views: needed when a setting changes the values
	 *  themselves, not only how they are displayed. */
	refreshViews() {
		this.cachedText = null;
		this.cachedMap = null;

		if (!this.settings.enabled.read) clearAttributes(document);

		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf?.view;
			if (!view) return;

			view.previewMode?.rerender?.(true);

			const editor = view.editor?.cm;
			if (editor) editor.dispatch({ effects: refreshEffect.of(null) });
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyCssVariables();
	}
}

function setOrClear(style, name, value, unit) {
	if (value === "" || value === null || typeof value === "undefined") style.removeProperty(name);
	else style.setProperty(name, `${value}${unit}`);
}

/**
 * Writes an editor block's attributes, but only those that change.
 *
 * This write happens during CodeMirror's measure phase: touching an attribute
 * that bears on layout invalidates the measurements under way and restarts the
 * cycle, up to the "Measure loop restarted more than 5 times" warning.
 * Comparing before writing is enough to break it, since the second pass no
 * longer modifies anything.
 */
function syncBlockAttributes(el, attributes) {
	for (const name of DATA_ATTRS) {
		const value = attributes[name];
		if (typeof value === "string") {
			if (el.getAttribute(name) !== value) el.setAttribute(name, value);
		} else if (el.hasAttribute(name)) {
			el.removeAttribute(name);
		}
	}
}

function clearBlockAttributes(el) {
	for (const name of DATA_ATTRS) {
		if (el.hasAttribute(name)) el.removeAttribute(name);
	}
}

function applyAttributes(el, attributes) {
	for (const name of DATA_ATTRS) {
		if (name in attributes) el.setAttribute(name, attributes[name]);
		else el.removeAttribute(name);
	}
}

function clearAttributes(root) {
	for (const name of DATA_ATTRS) {
		for (const el of Array.from(root.querySelectorAll(`[${name}]`))) {
			el.removeAttribute(name);
		}
	}
}

/**
 * Takes up the saved settings, whatever their age.
 *
 * The original format was flat: a single set of values, for Reading view
 * alone. It is poured as-is into "read", so that updating the plugin loses no
 * setting.
 */
function migrateSettings(raw) {
	const settings = {
		enabled: Object.assign({}, DEFAULT_SETTINGS.enabled),
		read: Object.assign({}, DEFAULT_MODE),
		edit: Object.assign({}, DEFAULT_MODE)
	};
	if (!raw || typeof raw !== "object") return settings;

	if (raw.read || raw.edit || raw.enabled) {
		Object.assign(settings.enabled, raw.enabled);
		Object.assign(settings.read, raw.read);
		Object.assign(settings.edit, raw.edit);
		return settings;
	}

	Object.assign(settings.read, raw);   // old flat format
	return settings;
}

/* ==================================================================
   Settings tab
   ================================================================== */

class HeadingIndentBarsSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		this.renderMode(containerEl, "read");
		this.renderMode(containerEl, "edit");
	}

	renderMode(containerEl, mode) {
		const settings = this.plugin.settings[mode];

		new Setting(containerEl)
			.setName(t(`mode.${mode}.name`))
			.setDesc(t(`mode.${mode}.desc`))
			.setHeading();

		new Setting(containerEl)
			.setName(t("enabled.name"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled[mode])
					.onChange(async (value) => {
						this.plugin.settings.enabled[mode] = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName(t("step.name"))
			.setDesc(t("step.desc"))
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_MODE.step))
					.setValue(String(settings.step))
					.onChange(async (value) => {
						settings.step = clamp(value, DEFAULT_MODE.step, 0, 200);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("barWidth.name"))
			.setDesc(t("barWidth.desc"))
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_MODE.barWidth))
					.setValue(String(settings.barWidth))
					.onChange(async (value) => {
						settings.barWidth = clamp(value, DEFAULT_MODE.barWidth, 1, 8);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("bleed.name"))
			.setDesc(t("bleed.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(String(settings.bleed))
					.onChange(async (value) => {
						settings.bleed = optional(value, 8, 0, 64);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("headingBleed.name"))
			.setDesc(t("headingBleed.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(String(settings.headingBleed))
					.onChange(async (value) => {
						settings.headingBleed = optional(value, 40, 0, 200);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("barColor.name"))
			.setDesc(t("barColor.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(settings.barColor)
					.onChange(async (value) => {
						settings.barColor = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("numbering.name"))
			.setDesc(t("numbering.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(settings.numbering)
					.onChange(async (value) => {
						settings.numbering = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName(t("numberingStart.name"))
			.setDesc(t("numberingStart.desc"))
			.addDropdown((dropdown) => {
				for (let level = 1; level <= 6; level++) dropdown.addOption(String(level), `H${level}`);
				dropdown
					.setValue(String(settings.numberingStart))
					.onChange(async (value) => {
						settings.numberingStart = clamp(value, DEFAULT_MODE.numberingStart, 1, 6);
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					});
			});

		new Setting(containerEl)
			.setName(t("numberGap.name"))
			.setDesc(t("numberGap.desc"))
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_MODE.numberGap))
					.setValue(String(settings.numberGap))
					.onChange(async (value) => {
						settings.numberGap = clamp(value, DEFAULT_MODE.numberGap, 0, 64);
						await this.plugin.saveSettings();
					})
			);

		if (mode === "read") {
			// Editing already spaces its first heading: its rule holds for
			// every heading line, with no condition on what comes before. In
			// Reading, the margin is only set if a text block precedes the
			// heading, which the first one by definition has not.
			new Setting(containerEl)
				.setName(t("firstHeadingSpace.name"))
				.setDesc(t("firstHeadingSpace.desc"))
				.addText((text) =>
					text
						.setPlaceholder("auto")
						.setValue(String(settings.firstHeadingSpace))
						.onChange(async (value) => {
							settings.firstHeadingSpace = optional(value, 16, 0, 200);
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName(t("tableSpace.name"))
				.setDesc(t("tableSpace.desc"))
				.addText((text) =>
					text
						.setPlaceholder("auto")
						.setValue(String(settings.tableSpace))
						.onChange(async (value) => {
							settings.tableSpace = optional(value, 16, 0, 200);
							await this.plugin.saveSettings();
						})
				);
			return;
		}

		// Reading view already renders lists as blocks: they carry their
		// indentation and their margin there with no intervention. In Editing
		// they are only lines, hence these settings that exist for that view
		// alone.
		new Setting(containerEl)
			.setName(t("listIndent.name"))
			.setDesc(t("listIndent.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(String(settings.listIndent))
					.onChange(async (value) => {
						settings.listIndent = optional(value, 32, 0, 200);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("listSpacing.name"))
			.setDesc(t("listSpacing.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(String(settings.listSpacing))
					.onChange(async (value) => {
						settings.listSpacing = optional(value, 16, 0, 64);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("listHanging.name"))
			.setDesc(t("listHanging.desc"))
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(String(settings.listHanging))
					.onChange(async (value) => {
						settings.listHanging = optional(value, 13, 0, 60);
						await this.plugin.saveSettings();
					})
			);
	}
}

function clamp(value, fallback, min, max) {
	const parsed = parseInt(String(value), 10);
	if (Number.isNaN(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

/** A numeric field whose empty value is a value of its own: "auto". */
function optional(value, fallback, min, max) {
	const trimmed = String(value).trim();
	return trimmed === "" ? "" : clamp(trimmed, fallback, min, max);
}

module.exports = HeadingIndentBars;
