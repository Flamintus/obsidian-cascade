"use strict";

/*
 * Cascade
 * -------
 * Trois fonctions, chacune activable separement :
 *   - indentation du contenu sous les titres
 *   - barre verticale par niveau parent, comme les guides des listes imbriquees
 *   - numerotation automatique des titres (1, 1.1, 1.1.1 ...)
 *
 * Deux modes, actives et regles independamment : Lecture (et export PDF) et
 * Edition (Live Preview et Source).
 *
 * Principe
 *   Niveaux et numeros sont lus dans la SOURCE Markdown, jamais deduits du
 *   rendu. Les deux modes appellent la meme fonction buildHeadingMap sur le
 *   meme texte : ils ne peuvent donc pas diverger.
 *
 *   C'est aussi ce qui rend le resultat insensible a la virtualisation, que
 *   les deux modes pratiquent : un parcours du DOM y perdrait le titre servant
 *   d'ancre, et des compteurs CSS y repartiraient de zero au defilement.
 *
 *   Le JS ne pose que des attributs data-hib-*. Tout le rendu est dans
 *   styles.css.
 *
 * Profondeur appliquee
 *   ligne de titre de niveau N -> N-1 crans
 *   contenu sous un titre N    -> N crans
 *   avant le premier titre     -> 0 cran
 */

const { Plugin, PluginSettingTab, Setting } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");
const { RangeSetBuilder, StateEffect } = require("@codemirror/state");

/* ==================================================================
   Reglages
   ================================================================== */

const DEFAULT_MODE = {
	step: 40,             // px par niveau d'indentation
	barWidth: 1,          // px
	bleed: "",            // px ; vide = auto (espacement des paragraphes)
	headingBleed: "",     // px ; vide = auto (marge superieure des titres)
	barColor: "",         // couleur CSS ; vide = couleur de bordure du theme
	numbering: true,      // numerotation automatique des titres
	numberingStart: 2,    // niveau de titre portant le premier rang
	numberGap: 8,         // px entre le numero et le texte du titre

	// Mode Edition seulement : le mode Lecture rend deja les listes comme des
	// blocs, ces deux reglages n'y ont donc pas d'objet.
	listIndent: "",       // px ; vide = auto (3ch - 0.8em, position de la puce en Lecture)
	listSpacing: "",      // px ; vide = auto (espacement des paragraphes)
	listHanging: "",      // px ; vide = auto (0.8em, recul de la puce en Lecture)

	// Mode Lecture seulement : l'Edition espace deja son premier titre, et ses
	// tableaux sont poses entre deux lignes jointives.
	firstHeadingSpace: "", // px ; vide = auto (espacement des paragraphes)
	tableSpace: ""         // px ; vide = auto (espacement des paragraphes)
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

/* Blocs que Live Preview ne rend pas sous forme de ligne : tableaux, callouts,
   blocs math, fichiers integres, images distantes. Aucune decoration de ligne
   ne les atteint, ils sont traites a part. */
const EMBED_SELECTOR = ":scope > .cm-embed-block, :scope > .math-block, :scope > .internal-embed, :scope > img";

/* Signale aux editeurs ouverts qu'un reglage a change : rien dans le document
   ne bouge, donc aucune transaction ne serait emise sans cela. */
const refreshEffect = StateEffect.define();

/* ==================================================================
   Lecture de la source
   ================================================================== */

/**
 * Construit, a partir du texte source, le niveau d'indentation de chaque ligne
 * et le numero de chaque ligne de titre.
 *
 * Ignore les titres qui n'en sont pas : lignes a l'interieur d'un bloc de code
 * clos par ``` ou ~~~, et front matter YAML en tete de fichier.
 *
 * @param {string} text contenu complet du fichier
 * @param {number} startLevel niveau de titre portant le premier rang (1 a 6)
 * @returns {{levels: number[], numbers: (string|null)[], headings: boolean[],
 *          joins: number[]}} indexes par numero de ligne (0-based) ; numbers
 *          vaut null hors ligne de titre numerotee ; headings marque les lignes
 *          de titre ; joins donne le nombre de barres deja ouvertes dans le
 *          bloc precedent, donc prolongeables vers le haut
 */
function buildHeadingMap(text, startLevel) {
	const lines = text.split("\n");
	const levels = new Array(lines.length).fill(0);
	const numbers = new Array(lines.length).fill(null);
	const headings = new Array(lines.length).fill(false);
	const joins = new Array(lines.length).fill(0);

	// Jeu propre au mode Edition. En Lecture, une ligne vide ne produit aucun
	// bloc ; en Edition elle occupe une hauteur et doit donc porter ses barres,
	// sous peine d'un trait coupe a chaque saut de ligne. Elle prend le niveau
	// de la derniere ligne pleine, et le raccord se calcule alors de proche en
	// proche plutot qu'en sautant les vides.
	const editLevels = new Array(lines.length).fill(0);
	const editJoins = new Array(lines.length).fill(0);

	// Lignes de liste, et premiere ligne de chaque liste. En Lecture, une liste
	// est un bloc qui porte sa propre indentation et sa marge ; en Edition ce ne
	// sont que des lignes ordinaires. Les reperer permet de leur rendre ces deux
	// proprietes, et donc d'aligner les deux modes.
	const lists = new Array(lines.length).fill(false);
	const listStarts = new Array(lines.length).fill(false);
	let lastFullLineWasList = false;

	// Premiere ligne pleine du document, front matter exclu. Le bloc qui
	// commence la n'a rien avant lui : en Lecture, aucune des regles
	// d'espacement d'Obsidian ne l'atteint.
	let firstLine = -1;

	// Lignes de tableau, et bloc qui en precede un.
	//
	// Obsidian pose « overflow-x: auto » en inline sur un bloc de tableau, pour
	// le defilement horizontal. Un overflow non visible rogne aussi le
	// debordement vertical : le raccord qu'un tableau trace au-dessus de sa
	// boite y est donc invisible. C'est au bloc precedent, lui non rogne, de
	// descendre jusqu'a lui.
	const tables = new Array(lines.length).fill(false);
	const beforeTables = new Array(lines.length).fill(false);

	const counters = [0, 0, 0, 0, 0, 0, 0];   // indexes 1 a 6, la case 0 est inutilisee
	let current = 0;        // niveau du dernier titre rencontre
	let fenceChar = "";     // ` ou ~ si on est dans un bloc de code, sinon ""
	let fenceLength = 0;
	let lastLevel = -1;     // niveau du bloc precedent ; -1 tant qu'il n'y en a pas
	let i = 0;

	// Front matter : tout ce qui est entre les deux --- reste au niveau 0.
	if (lines.length > 0 && lines[0].trim() === "---") {
		i = 1;
		while (i < lines.length && lines[i].trim() !== "---") i++;
		if (i < lines.length) i++;
	}

	for (; i < lines.length; i++) {
		const line = lines[i];
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);

		if (fenceChar !== "") {
			// Dans un bloc de code : seule une cloture du meme type et au moins
			// aussi longue en sort. Aucun titre n'est reconnu d'ici la.
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

				// Puce ou numero suivi d'une espace. Un separateur horizontal
				// (---) n'en a pas, il n'est donc pas confondu avec une puce.
				if (/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line)) {
					lists[i] = true;
					listStarts[i] = !lastFullLineWasList;
				} else if (/^[ \t]*\|/.test(line)) {
					tables[i] = true;
				}
			} else {
				const level = heading[1].length;
				current = level;
				levels[i] = level - 1;   // la ligne du titre s'aligne sur son parent
				headings[i] = true;

				// Tout titre remet a zero les rangs plus profonds, y compris un
				// titre situe au-dessus de startLevel : c'est ce qui fait
				// repartir la numerotation a 1 dans chaque nouveau chapitre.
				for (let deeper = level + 1; deeper <= 6; deeper++) counters[deeper] = 0;

				if (level >= startLevel) {
					// Niveau saute (un H4 juste apres un H2) : on ouvre le rang
					// manquant a 1 plutot que d'afficher un zero.
					for (let above = startLevel; above < level; above++) {
						if (counters[above] === 0) counters[above] = 1;
					}
					counters[level] += 1;
					numbers[i] = counters.slice(startLevel, level + 1).join(".");
				}
			}
		}

		// Barres prolongeables vers le haut : celles que le bloc precedent
		// tracait deja. Un titre en ouvre une nouvelle, plus profonde, qui n'a
		// aucune raison de remonter au-dessus de lui — c'est elle qui doit
		// demarrer a sa hauteur, comme elle demarrerait au premier paragraphe
		// d'une section ordinaire.
		joins[i] = lastLevel < 0 ? 0 : Math.min(levels[i], lastLevel);

		const blank = line.trim() === "";
		editLevels[i] = blank ? Math.max(lastLevel, 0) : levels[i];
		editJoins[i] = i === 0 ? 0 : Math.min(editLevels[i], editLevels[i - 1]);

		// Une ligne vide separe deux blocs sans en constituer un. C'est aussi
		// pourquoi elle ne rompt pas une liste : une ligne vide entre deux
		// puces n'ouvre pas une seconde liste, en Markdown comme a l'ecran.
		if (!blank) {
			if (firstLine < 0) firstLine = i;
			lastLevel = levels[i];
			lastFullLineWasList = lists[i];
		}
	}

	// Seconde passe : reperer le bloc qui precede chaque tableau. Le marquage
	// porte sur sa premiere ligne, celle qui identifie le bloc au rendu.
	let openBlock = -1;    // premiere ligne du bloc en cours, -1 entre deux blocs
	let lastBlock = -1;    // premiere ligne du bloc precedent
	for (let k = 0; k < lines.length; k++) {
		if (lines[k].trim() === "") {
			if (openBlock >= 0) {
				lastBlock = openBlock;
				openBlock = -1;
			}
			continue;
		}
		if (openBlock >= 0) continue;   // suite du bloc en cours

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
 * Attributs d'un bloc, a partir de la carte et de l'index de sa premiere ligne.
 *
 * Le numero est pose meme quand la numerotation est desactivee : c'est une
 * classe sur <body> qui commande son affichage. Basculer le reglage reste ainsi
 * immediat, sans re-rendu des notes ouvertes.
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

	// Le mode Lecture n'en a pas besoin : Obsidian y rend deja les listes comme
	// des blocs, avec leur indentation et leur marge.
	if (mode === "edit") {
		if (map.lists[index]) attributes["data-hib-list"] = "1";
		if (map.listStarts[index]) attributes["data-hib-list-start"] = "1";
	}

	// Reciproquement, l'Edition espace deja son premier titre : la regle
	// d'Obsidian y vaut pour toute ligne de titre, sans condition sur ce qui
	// precede.
	if (mode === "read") {
		if (index === map.firstLine) attributes["data-hib-first"] = "1";

		// L'Edition n'en a pas besoin : son tableau est un bloc unique, pose
		// entre deux lignes jointives, sans marge a franchir.
		if (map.tables[index]) attributes["data-hib-table"] = "1";
		if (map.beforeTables[index]) attributes["data-hib-before-table"] = "1";
	}

	return attributes;
}

/* ==================================================================
   Mode Edition — extension CodeMirror
   ================================================================== */

/**
 * Pose les memes attributs que le mode Lecture sur les lignes visibles, via des
 * decorations de ligne, et sur les blocs que Live Preview ne rend pas en lignes.
 *
 * La carte est calculee sur le document entier — seul moyen de connaitre le
 * titre courant d'une ligne visible dont l'ancre est hors ecran — mais les
 * decorations ne sont posees que sur le viewport.
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
			 * Tableaux, callouts, blocs math et images sont des blocs a part,
			 * enfants directs du conteneur et non des lignes : les decorations
			 * ne les atteignent pas. On leur pose les memes attributs a la main,
			 * en passant par leur position dans le document.
			 *
			 * Ecriture differee via requestMeasure : le DOM n'est pas encore a
			 * jour au moment de l'update.
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
								continue;   // bloc detache entre l'update et la mesure
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

		// Cache a une entree : getSectionInfo renvoie la meme instance de chaine
		// pour toutes les sections d'un meme rendu, la comparaison est donc une
		// egalite de reference.
		this.cachedText = null;
		this.cachedStart = null;
		this.cachedMap = null;

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.enabled.read) return;

			const info = ctx.getSectionInfo(el);
			if (!info) return;   // bloc sans origine dans le fichier (titre en ligne, embed)

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
	 * Marque le bloc du mode Lecture.
	 *
	 * L'element recu par le post-processeur est parfois re-enveloppe par
	 * Obsidian dans le <div class="el-..."> qui portera reellement la
	 * geometrie du bloc. On reporte alors les attributs sur cet ancetre, faute
	 * de quoi l'indentation s'appliquerait a une boite interne. Ils sont retires
	 * de l'element d'origine pour eviter un decalage applique deux fois.
	 *
	 * Le numero est pose sur le <hN> lui-meme, pour s'inserer dans son texte.
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
			if (!section) return;   // pas encore insere : les attributs restent sur el

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

	/** Recalcule les vues ouvertes : necessaire quand un reglage change les
	 *  valeurs elles-memes, pas seulement leur affichage. */
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
 * Ecrit les attributs d'un bloc de l'editeur, mais uniquement ceux qui changent.
 *
 * Cette ecriture a lieu dans la phase de mesure de CodeMirror : toucher un
 * attribut qui influe sur la mise en page invalide les mesures en cours et
 * relance le cycle, jusqu'a l'avertissement « Measure loop restarted more than
 * 5 times ». Comparer avant d'ecrire suffit a le rompre, puisque le second
 * passage ne modifie plus rien.
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
 * Reprend les reglages enregistres, quel que soit leur age.
 *
 * Le format d'origine etait plat : un seul jeu de valeurs, pour le mode Lecture
 * seul. Il est reverse tel quel dans « read », de sorte qu'une mise a jour du
 * plugin ne fasse perdre aucun reglage.
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

	Object.assign(settings.read, raw);   // ancien format plat
	return settings;
}

/* ==================================================================
   Onglet de reglages
   ================================================================== */

class HeadingIndentBarsSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		this.renderMode(containerEl, "read", "Mode Lecture", "S'applique aussi à l'export PDF.");
		this.renderMode(containerEl, "edit", "Mode Édition", "Live Preview et mode Source.");
	}

	renderMode(containerEl, mode, title, description) {
		const settings = this.plugin.settings[mode];

		new Setting(containerEl).setName(title).setDesc(description).setHeading();

		new Setting(containerEl)
			.setName("Activer dans ce mode")
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
			.setName("Décalage par niveau")
			.setDesc("En pixels. Le contenu sous un H2 est décalé de deux fois cette valeur. Au-delà de 50, les tableaux profonds deviennent étroits.")
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
			.setName("Épaisseur des barres")
			.setDesc("En pixels.")
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
			.setName("Raccord entre deux blocs")
			.setDesc("En pixels. Hauteur du trait qui relie un bloc au bloc précédent. Vide = espacement des paragraphes du thème. Augmente si les barres apparaissent pointillées entre deux paragraphes.")
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
			.setName("Raccord au-dessus d'un titre")
			.setDesc("En pixels. L'espace qui précède un titre est bien plus large que celui qui sépare deux paragraphes : son raccord lui est donc propre, sans quoi les barres se coupent juste avant chaque titre. Vide = marge supérieure des titres du thème.")
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
			.setName("Couleur des barres")
			.setDesc("Couleur CSS. Vide = couleur de bordure du thème, qui suit le mode clair et sombre.")
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
			.setName("Numéroter les titres")
			.setDesc("Ajoute 1, 1.1, 1.1.1 devant chaque titre, en affichage seulement : les fichiers Markdown ne sont jamais modifiés.")
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
			.setName("Premier niveau numéroté")
			.setDesc("Niveau de titre qui porte le rang 1. Sur 2, le H1 en tête de note n'est pas numéroté et les H2 deviennent 1, 2, 3. Sur 1, le H1 devient 1 et les H2 deviennent 1.1, 1.2.")
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
			.setName("Espace après le numéro")
			.setDesc("En pixels, entre le numéro et le texte du titre. En pixels et non en em, pour que l'écart reste le même à tous les niveaux de titre.")
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
			// L'Edition espace deja son premier titre : sa regle vaut pour toute
			// ligne de titre, sans condition sur ce qui precede. En Lecture, la
			// marge n'est posee que si un bloc de texte precede le titre, ce que
			// le premier n'a par definition pas.
			new Setting(containerEl)
				.setName("Marge au-dessus du premier titre")
				.setDesc("En pixels. Ne concerne que le titre en tête de note, qu'Obsidian laisse sans marge faute de bloc avant lui. Vide = espacement des paragraphes, la valeur qu'applique le mode Édition.")
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
				.setName("Espace autour d'un tableau")
				.setDesc("En pixels, au-dessus et au-dessous. Reprend la marge qu'Obsidian donne aux tableaux, mais posée à l'intérieur du bloc pour que les barres la traversent au lieu de s'y interrompre. Vide = espacement des paragraphes, donc apparence inchangée.")
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

		// Le mode Lecture rend deja les listes comme des blocs : elles y portent
		// leur indentation et leur marge sans qu'on ait a intervenir. En Edition
		// ce ne sont que des lignes, d'ou ces deux reglages qui n'existent que
		// pour ce mode.
		new Setting(containerEl)
			.setName("Décalage des listes")
			.setDesc("En pixels, jusqu'à la puce. Vide = la position qu'elle occupe en mode Lecture, où le texte de l'item se tient à 3ch et la puce 0.8em avant lui.")
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
			.setName("Marge avant une liste")
			.setDesc("En pixels, au-dessus de la première puce seulement. Vide = espacement des paragraphes du thème.")
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
			.setName("Retrait de la puce")
			.setDesc("En pixels. Recul de la puce par rapport au texte de son item, qui seul porte le décalage des listes. C'est ce retrait qui aligne les lignes repliées sous le texte plutôt que sous la puce. Vide = 0.8em, la valeur du mode Lecture.")
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

/** Champ numerique dont le vide est une valeur : « auto ». */
function optional(value, fallback, min, max) {
	const trimmed = String(value).trim();
	return trimmed === "" ? "" : clamp(trimmed, fallback, min, max);
}

module.exports = HeadingIndentBars;
