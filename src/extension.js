//@ts-check
'use strict';
const vscode = require('vscode');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const SyntaxTokenModifier = {
	Constant: 'readonly',
	Iterable: 'iterable',
};
const SyntaxTokenType = {
	Class: 'class',
	Function: 'function',
	Variable: 'variable',
	Parameter: 'parameter',
	Module: 'namespace',
	KeywordControl: 'control',
};
/**
 * @typedef {{ line: number, column: number }} Position;
 * @typedef {{ start: Position, end: Position }} Location
 */
/**
 * @typedef {{
 *   class: 'fn' | 'constructor_fn',
 *   params: (DataType|null)[],
 *   ret: DataType|null
 * }} FnDataType
 * @typedef {{
 *   class: 'mod',
 *   path: string
 * }} ModDataType
 * @typedef {{
 *   class: 'clase',
 *   static_props: Record<string,DataType|null>,
 *   instance_props: Record<string,DataType|null>,
 *   name: String
 * }} ClassDataType
 * @typedef {{
 *   class: 'agal',
 *   type: 'numero' | 'byte' | 'nada' | 'buleano' | 'caracter'
 * } | {
 *   class: 'agal',
 *   type: 'referencia' | 'lista' | 'iterable',
 *   val: DataType
 * } | {
 *   class: 'agal',
 *   type: 'cadena',
 *   val?: string
 * } | {
 *   class: 'id',
 *   location: Location
 * } | {
 *   class: 'params',
 *   location: Location,
 * } | {
 *   class: 'param',
 *   location: Location,
 *   index: number
 * } | {
 *   class: 'instancia',
 *   props: Record<string,DataType|null>,
 *   name: String
 * } | {
 *   class: 'ret' | 'constructor' | 'item' | 'promesa',
 *   val: DataType
 * } | {
 *   class: 'member',
 *   object: DataType,
 *   member: DataType,
 *   is_instance: boolean
 * } | {
 *   class: 'multiple',
 *   val: (DataType|null)[]
 * } | {
 *   class: 'llamada',
 *   callee: DataType,
 *   args: (DataType|null)[]
 * } | FnDataType | ModDataType | ClassDataType} DataType
 */
/**
 * @typedef {{
 * definition: Position,
 * location: Location,
 * token_type: keyof typeof SyntaxTokenType,
 * token_modifier: Array<keyof typeof SyntaxTokenModifier>,
 * data_type: DataType?,
 * is_original_decl: false
 * } | {
 * definition: Position,
 * location: Location,
 * token_type: 'Function',
 * token_modifier: Array<keyof typeof SyntaxTokenModifier>,
 * data_type: FnDataType,
 * is_original_decl: true
 * } | {
 * definition: Position,
 * location: Location,
 * token_type: 'Module',
 * token_modifier: Array<keyof typeof SyntaxTokenModifier>,
 * data_type: ModDataType,
 * is_original_decl: true
 * }} SemanticToken
 */
class AgaTokenizer {
	/** @type {Record<string, SemanticToken[]>} */
	#tokens = {};
	/** @type {Record<string, ClassDataType>} */
	#mod = {};
	/** @type {Record<string, string>} */
	#hashes = {};
	/** @type {Record<string, number>} */
	#versions = {};

	/** @param {string} content */
	static #hash(content) {
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	/**@param {string} file @returns {ClassDataType|null}*/
	readMod(file) {
		return this.#mod[file] || null;
	}

	/** @param {string} file @returns {SemanticToken[]} */
	#read(file) {
		try {
			const exe = vscode.workspace.getConfiguration('agalang').get('exe_path');
			const output = cp.execSync(`${exe} tokens "${file}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
			const {file: file_tokens, mod} = JSON.parse(output);
			this.#mod[file] = mod;
			return file_tokens;
		} catch (e) {
			/**@type {string}*/
			const stderr = e.stderr?.toString?.() ?? '';
			const lines = stderr.split('\n');
			if (lines[0].startsWith('\x1B[1m\x1B[91merror\x1B[39m:\x1B[0m')) {
				const message = lines[0].replace('\x1B[1m\x1B[91merror\x1B[39m:\x1B[0m', '').trim();
				const [column_str, line_str, ...list] = lines[1].split(':').reverse();
				const file = list.reverse().join(':').split('>')[1].trim();
				const length = lines[4].split('-').length - 1;
				throw { message, line: Number(line_str) - 1, column: Number(column_str) - 1, length: length || 1, file };
			}
			console.log(e);
			return [];
		}
	}

	/** @param {vscode.TextDocument} doc @returns {SemanticToken[]} */
	read(doc) {
		if (this.maybeUpdate(doc)) {
			this.#tokens[doc.fileName] = this.#read(doc.fileName).sort((a, b) => {
				if (a.location.start.line === b.location.start.line) return a.location.start.column - b.location.start.column;
				return a.location.start.line - b.location.start.line;
			});
		}
		return this.#tokens[doc.fileName];
	}

	/** @param {vscode.TextDocument} doc @param {{character:number,line:number}} pos */
	find(doc, pos) {
		return this.read(doc).find(token => {
			const s = token.location.start;
			const e = token.location.end;
			return (
				(s.line < pos.line || (s.line === pos.line && s.column <= pos.character)) &&
				(e.line > pos.line || (e.line === pos.line && e.column >= pos.character))
			);
		});
	}
	/** @param {vscode.TextDocument} doc @param {{character:number,line:number}} pos */
	filter(doc, pos) {
		return this.read(doc).filter(token => {
			const s = token.location.start;
			const e = token.location.end;
			return (
				(s.line < pos.line || (s.line === pos.line && s.column <= pos.character)) &&
				(e.line > pos.line || (e.line === pos.line && e.column >= pos.character))
			);
		});
	}

	/**@param {vscode.TextDocument} doc */
	maybeUpdate(doc) {
		if (!this.#tokens[doc.fileName]) return true;
		if (this.#versions[doc.fileName] === doc.version) return false;
		if (this.#hashes[doc.fileName] === AgaTokenizer.#hash(doc.getText())) return false;
		delete this.#tokens[doc.fileName];
		return true;
	}

	/**@param {string} file*/
	clear(file) {
		delete this.#tokens[file];
		delete this.#hashes[file];
		delete this.#versions[file];
	}
}

/**@param {vscode.TextDocument} doc@param {AgaTokenizer}tokenizer@param {DataType?}dataType@returns {DataType|null}*/
function resolveDataType(doc, tokenizer, dataType) {
	if (!dataType) {
		return null;
	}
	if (dataType.class === 'multiple') dataType.val = dataType.val.map(dt => resolveDataType(doc, tokenizer, dt));
	if (dataType.class === 'fn' || dataType.class === 'constructor_fn') {
		dataType.params = dataType.params.map(dt => resolveDataType(doc, tokenizer, dt));
		dataType.ret = resolveDataType(doc, tokenizer, dataType.ret);
	}
	if (dataType.class === 'agal')
		if (dataType.type === 'lista' || dataType.type === 'iterable' || dataType.type === 'referencia')
			//@ts-ignore
			dataType.val = resolveDataType(doc, tokenizer, dataType.val);
	if (dataType.class === 'ret' || dataType.class === 'constructor' || dataType.class === 'item')
		//@ts-ignore
		dataType.val = resolveDataType(doc, tokenizer, dataType.val);

	if (dataType.class === 'id') {
		let token = tokenizer.find(doc, { line: dataType.location.start.line, character: dataType.location.start.column })?.data_type;
		if (!token) return null;
		return resolveDataType(doc, tokenizer, token);
	}

	return dataType;
}

/**@param {DataType?}dataType@param {{maxLength?:number,showString?:boolean,multilineString?:boolean}}param2@returns {string}*/
function typeToString(dataType, { maxLength = Infinity, multilineString, showString }) {
	if (!dataType) return 'Desconocido';
	if (maxLength <= 0) maxLength = 0;
	if (dataType.class === 'agal')
		if (dataType.type === 'cadena' && typeof dataType.val === 'string' && showString !== false) {
			const preString = dataType.val
				.replaceAll('\\', '\\\\')
				.replaceAll("'", "\\'")
				.replaceAll('\r', '\\r')
				.replaceAll('\t', '\\t')
				.replaceAll('\0', '\\0');
			const string = multilineString === false ? preString.replaceAll('\n', '\\n') : preString.split('\n').join("\\n' +\n'");
			if (Number.isFinite(maxLength)) {
				if (string.length + 2 <= maxLength) return "'" + string + "'";
				else if (string.length + 2 >= maxLength && maxLength >= 5) return "'" + string.substring(0, maxLength - 2).trimEnd() + "...'";
				else return "'...'";
			}
			return "'" + string + "'";
		} else if (dataType.type === 'lista') {
			let content = typeToString(dataType.val, { maxLength: maxLength - 2, multilineString, showString });
			return content && `[${content}]`;
		} else if (dataType.type === 'iterable') {
			let content = typeToString(dataType.val, { maxLength: maxLength - 1, multilineString, showString });
			return content && `@${content}`;
		} else return dataType.type.charAt(0).toUpperCase() + dataType.type.slice(1);
	if (dataType.class === 'fn')
		return `fn (${dataType.params
			.map(d => typeToString(d, { maxLength: maxLength - 9, multilineString, showString }))
			.join(', ')}){ ${typeToString(dataType.ret, { maxLength: maxLength - 9, multilineString, showString })} }`;
	if (dataType.class === 'clase') return `clase ${dataType.name}`;
	if (dataType.class === 'constructor_fn')
		return `clase ${typeToString(dataType.ret, { maxLength: maxLength - 6, multilineString, showString })}`;
	if (dataType.class === 'constructor')
		return `clase ${typeToString(dataType.val, { maxLength: maxLength - 6, multilineString, showString })}`;
	if (dataType.class === 'multiple') {
		let string = '';
		for (const data of dataType.val) {
			if (string.length) string += ' | ';
			let length = maxLength - string.length;
			let part = typeToString(data, { maxLength: length, multilineString, showString });
			if (part.length + length <= maxLength) {
				string += part;
			} else {
				string += '...';
				break;
			}
		}
		return string;
	}
	if (dataType.class === 'instancia') return dataType.name;
	if (dataType.class === 'mod') return `importa '${dataType.path}'`;
	if (dataType.class === 'param') return `Param_${dataType.index}?`;
	if (dataType.class === 'params') return '@Params?';
	if (dataType.class === 'item')
		return `Elemento<${typeToString(dataType.val, { maxLength: maxLength - 10, multilineString, showString })}>`;
	if (dataType.class === 'promesa') return `asinc ${typeToString(dataType.val, { maxLength: maxLength - 6, multilineString, showString })}`;
	if (dataType.class === 'ret') return `ret ${typeToString(dataType.val, { maxLength: maxLength - 4, multilineString, showString })}`;
	if (dataType.class === 'member') {
		let identifier =
			dataType.member.class === 'agal' && dataType.member.type === 'cadena' && dataType.member.val ? dataType.member.val : null;
		let member = identifier
			? `${dataType.is_instance ? '::' : '.'}${identifier}`
			: `${dataType.is_instance ? '::' : ''}[${typeToString(dataType.member, {
					maxLength: maxLength - (dataType.is_instance ? 4 : 2),
					multilineString,
					showString,
			  })}]`;
		let restLength = maxLength - member.length;
		let object = typeToString(dataType.object, { maxLength: restLength, multilineString, showString });
		return `(${object.length > restLength ? '...' : object})${member}`;
	}
	if (dataType.class === 'id') return `${dataType.location.start.line},${dataType.location.start.column}`;
	if (dataType.class === 'llamada') {
		let callee = typeToString(dataType.callee, { maxLength: maxLength - 5, multilineString, showString });
		let string = '';

		for (const data of dataType.args) {
			if (string.length) string += ', ';
			else string += callee + '(';

			let length = maxLength - string.length;
			let part = typeToString(data, { maxLength: length, multilineString, showString });
			if (part.length + length <= maxLength) {
				string += part;
			} else {
				string += '...';
				break;
			}
		}
		return string + ')';
	}
	return JSON.stringify(dataType);
}
/**@param {DataType?}data@returns {DataType?}*/
// @ts-ignore
function simplifyType(data) {
	if (!data) return null;

	if (data.class === 'multiple') {
		const uniqueVals = removeDuplicates(data.val.map(simplifyType).filter(v => v != null));

		if (uniqueVals.length === 0) return null;
		if (uniqueVals.length === 1) return uniqueVals[0];

		return {
			class: 'multiple',
			val: uniqueVals,
		};
	}

	if (data.class === 'agal' && (data.type === 'referencia' || data.type === 'lista' || data.type === 'iterable')) {
		return {
			...data,
			// @ts-ignore
			val: simplifyType(data.val),
		};
	}

	if (data.class === 'instancia') {
		const props = data.props;
		for (const key in props) props[key] = simplifyType(props[key]);
		return {
			...data,
			props,
		};
	}
	if (data.class === 'clase') {
		const static_props = data.static_props;
		for (const key in static_props) static_props[key] = simplifyType(static_props[key]);
		const instance_props = data.instance_props;
		for (const key in instance_props) instance_props[key] = simplifyType(instance_props[key]);
		return {
			...data,
			static_props,
			instance_props,
		};
	}

	if (data.class === 'ret' || data.class === 'constructor' || data.class === 'item') {
		return {
			...data,
			// @ts-ignore
			val: simplifyType(data.val),
		};
	}

	if (data.class === 'fn' || data.class === 'constructor_fn') {
		return {
			...data,
			params: data.params.map(simplifyType),
			ret: simplifyType(data.ret),
		};
	}

	return data;
}

/**@param {DataType[]}arr*/
function removeDuplicates(arr) {
	/**@type {Set<string>}*/
	const seen = new Set();
	/**@type {DataType[]}*/
	const result = [];

	for (const item of arr) {
		const json = JSON.stringify(item);
		if (!seen.has(json)) {
			seen.add(json);
			result.push(item);
		}
	}

	return result;
}

/**@param {vscode.MarkdownString}md@param {vscode.TextDocument}document@param {AgaTokenizer}tokenizer@param {SemanticToken?}symbol@returns {vscode.MarkdownString}*/
function hoverType(md, document, tokenizer, symbol) {
	try {
		md.appendMarkdown(`### Tipo de dato\n`);
		if (symbol?.data_type) symbol.data_type = simplifyType(resolveDataType(document, tokenizer, symbol?.data_type));
		let type = symbol?.data_type ?? null;

		type ? md.appendCodeblock(typeToString(type, {})) : md.appendText(JSON.stringify(type));
		md.appendMarkdown(`### Tipo de dato crudo\n`).appendCodeblock(JSON.stringify(symbol?.data_type ?? null));
	} catch (e) {
		console.log(e);
	}
	return md;
}
/**@param {vscode.TextDocument}document@param {vscode.Position}position@returns {string | null}*/
function getStringLiteralAtPosition(document, position) {
	const lineText = document.lineAt(position.line).text;
	const offset = position.character;

	const regex = /(["'])(?:\\.|[^\\])*?\1/g;
	let match;

	while ((match = regex.exec(lineText))) {
		const start = match.index;
		const end = regex.lastIndex;

		if (offset >= start && offset <= end) {
			return match[0];
		}
	}

	return null;
}

module.exports = {
	/**@param {vscode.ExtensionContext} context */
	async activate(context) {
		const tokenizer = new AgaTokenizer();
		const tokenTypes = Object.values(SyntaxTokenType);
		const tokenModifiers = Object.values(SyntaxTokenModifier);
		const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);
		const semanticTokensChangedEmitter = new vscode.EventEmitter();
		const decorationType = vscode.window.createTextEditorDecorationType({
			after: {
				color: '#888888',
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
		});
		/**@param {vscode.TextEditor}editor*/
		function updateInlineTypes(editor) {
			const config_types = vscode.workspace.getConfiguration('agalang.types');
			const options = /**@type {const} */ {
				multilineString: false,
				showString: config_types.get('showString') ?? true,
				maxLength: config_types.get('maxLength') ?? 15,
			};
			/**@type {vscode.DecorationOptions[]}*/
			const decorations = [];
			const tokens = tokenizer
				.read(editor.document)
				.filter(
					data =>
						data.location.start.column !== 0 &&
						data.definition.line === data.location.start.line &&
						data.definition.column === data.location.start.column &&
						(data.is_original_decl ? data.token_type === 'Function' : true)
				)
				.map(d => {
					d.data_type = simplifyType(resolveDataType(editor.document, tokenizer, d?.data_type));
					return d;
				});
			for (const token of tokens) {
				const start = new vscode.Position(token.location.start.line, token.location.start.column);
				const end = new vscode.Position(token.location.end.line, token.location.end.column);
				decorations.push({
					range: new vscode.Range(start, end),
					renderOptions: {
						after: {
							contentText:
								token.is_original_decl && token.token_type === 'Function'
									? ' ' + typeToString(token.data_type.ret, options) + ' '
									: `: ${typeToString(token.data_type, options)}`,
						},
					},
				});
			}

			editor.setDecorations(decorationType, decorations);
		}
		/**@param {vscode.TextDocument} doc*/
		function handleChange(doc) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document === doc) updateInlineTypes(editor);
			const updated = tokenizer.maybeUpdate(doc);
			if (updated) semanticTokensChangedEmitter.fire(doc);
		}
		let diagnostics = vscode.languages.createDiagnosticCollection('agalanguage');
		let onCloseFile = vscode.workspace.onDidCloseTextDocument(doc => {
			tokenizer.clear(doc.fileName);
			diagnostics.delete(doc.uri);
		});
		let onSaveFile = vscode.workspace.onDidSaveTextDocument(handleChange);
		let onOpenFile = vscode.workspace.onDidOpenTextDocument(handleChange);
		let onChangeActive = vscode.window.onDidChangeActiveTextEditor(editor => editor && handleChange(editor.document));
		let semanticTokensProvider = vscode.languages.registerDocumentSemanticTokensProvider(
			'agalanguage',
			{
				provideDocumentSemanticTokens(document) {
					const builder = new vscode.SemanticTokensBuilder(legend);
					diagnostics.delete(document.uri);
					try {
						for (const data of tokenizer.read(document))
							builder.push(
								new vscode.Range(
									new vscode.Position(data.location.start.line, data.location.start.column),
									new vscode.Position(data.location.end.line, data.location.end.column)
								),
								SyntaxTokenType[data.token_type],
								data.token_modifier.map(mod => SyntaxTokenModifier[mod])
							);
					} catch (err) {
						// @ts-ignore
						const { message, line, column, length, file } = err;
						const range = new vscode.Range(line, column, line, column + length);
						const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
						diagnostics.set(document.uri, [diagnostic]);
					}

					return builder.build();
				},
				onDidChangeSemanticTokens: semanticTokensChangedEmitter.event,
			},
			legend
		);
		let definitionProvider = vscode.languages.registerDefinitionProvider('agalanguage', {
			provideDefinition(document, position, _) {
				let token = tokenizer.find(document, position);
				if (token) return new vscode.Location(document.uri, new vscode.Position(token.definition.line, token.definition.column));
				return null;
			},
		});
		let renameProvider = vscode.languages.registerRenameProvider('agalanguage', {
			// @ts-ignore
			prepareRename(document, position, token) {
				const symbol = tokenizer.find(document, position);
				if (!symbol) {
					throw new Error('No se puede renombrar aquí.');
				}
				const range = new vscode.Range(
					new vscode.Position(symbol.location.start.line, symbol.location.start.column),
					new vscode.Position(symbol.location.end.line, symbol.location.end.column)
				);
				return range;
			},
			// @ts-ignore
			provideRenameEdits(document, position, newName, token) {
				const symbol = tokenizer.find(document, position);
				if (!symbol) return null;

				const workspaceEdit = new vscode.WorkspaceEdit();
				const tokens = tokenizer.read(document);

				// Encuentra todos los tokens con la misma definición
				for (const t of tokens) {
					if (t.definition.line === symbol.definition.line && t.definition.column === symbol.definition.column) {
						const range = new vscode.Range(
							new vscode.Position(t.location.start.line, t.location.start.column),
							new vscode.Position(t.location.end.line, t.location.end.column)
						);
						workspaceEdit.replace(document.uri, range, newName);
					}
				}

				return workspaceEdit;
			},
		});
		let completionItemProvider = vscode.languages.registerCompletionItemProvider(
			'agalanguage',
			{
				// @ts-ignore
				provideCompletionItems(document, position, token) {
					const items = [];
					const tokens = tokenizer.read(document);

					const seen = new Set();

					for (const t of tokens) {
						const range = new vscode.Range(
							new vscode.Position(t.location.start.line, t.location.start.column),
							new vscode.Position(t.location.end.line, t.location.end.column)
						);
						const label = document.getText(range);

						if (seen.has(label)) continue;
						seen.add(label);

						const item = new vscode.CompletionItem(
							label,
							vscode.CompletionItemKind[t.token_type.charAt(0).toUpperCase() + t.token_type.slice(1)] || vscode.CompletionItemKind.Text
						);
						item.detail = t.token_type;
						if (t.data_type) item.documentation = `Tipo: ${t.data_type}`;

						item.range = new vscode.Range(position, position); // para evitar reemplazar
						items.push(item);
					}

					return items;
				},
			},
			'.' // ⬅️ activa autocompletado al escribir puntos (puedes agregar más triggers si quieres)
		);
		let hoverProvider = vscode.languages.registerHoverProvider('agalanguage', {
			// @ts-ignore
			provideHover(document, position, _) {
				const comment = document.getWordRangeAtPosition(position, /#.*$/);
				if (comment) {
					const word = document.getText(comment);
					return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(word));
				}
				const stringLiteral = getStringLiteralAtPosition(document, position);
				if (typeof stringLiteral === 'string') {
					return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(stringLiteral).appendMarkdown(`### Literal de texto 📝\n`));
				}
				const byte = document.getWordRangeAtPosition(position, /(0by[01](_?[01]){0,7})/);
				if (byte) {
					const word = document.getText(byte);
					return new vscode.Hover(
						new vscode.MarkdownString()
							.appendCodeblock(word)
							.appendMarkdown(`### Literal de un byte 💾\n`)
							.appendText(`Valor: ${parseInt(word.substring(3).replaceAll('_', ''), 2)}`)
					);
				}
				const identifier = document.getWordRangeAtPosition(position, /[a-zA-ZñÑ_$][a-zA-ZñÑ0-9_$]*/);
				if (identifier) {
					const word = document.getText(identifier);
					const symbol = tokenizer.find(document, position);
					return new vscode.Hover(hoverType(new vscode.MarkdownString().appendCodeblock(word), document, tokenizer, symbol ?? null));
				}
				const numberBaseRange = document.getWordRangeAtPosition(
					position,
					/(0n(2[|][01](_?[01])*|3[|][0-2](_?[0-2])*|4[|][0-3](_?[0-3])*|5[|][0-4](_?[0-4])*|6[|][0-5](_?[0-5])*|7[|][0-6](_?[0-6])*|8[|][0-7](_?[0-7])*|9[|][0-8](_?[0-8])*|10[|][0-9](_?[0-9])*|11[|][0-9aA](_?[0-9aA])*|12[|][0-9a-bA-B](_?[0-9a-bA-B])*|13[|][0-9a-cA-C](_?[0-9a-cA-C])*|14[|][0-9a-dA-D](_?[0-9a-dA-D])*|15[|][0-9a-eA-E](_?[0-9a-eA-E])*|16[|][0-9a-fA-F](_?[0-9a-fA-F])*|17[|][0-9a-gA-G](_?[0-9a-gA-G])*|18[|][0-9a-hA-H](_?[0-9a-hA-H])*|19[|][0-9a-iA-I](_?[0-9a-iA-I])*|20[|][0-9a-jA-J](_?[0-9a-jA-J])*|21[|][0-9a-kA-K](_?[0-9a-kA-K])*|22[|][0-9a-lA-L](_?[0-9a-lA-L])*|23[|][0-9a-mA-M](_?[0-9a-mA-M])*|24[|][0-9a-nA-N](_?[0-9a-nA-N])*|25[|][0-9a-oA-O](_?[0-9a-oA-O])*|26[|][0-9a-pA-P](_?[0-9a-pA-P])*|27[|][0-9a-qA-Q](_?[0-9a-qA-Q])*|28[|][0-9a-rA-R](_?[0-9a-rA-R])*|29[|][0-9a-sA-S](_?[0-9a-sA-S])*|30[|][0-9a-tA-T](_?[0-9a-tA-T])*|31[|][0-9a-uA-U](_?[0-9a-uA-U])*|32[|][0-9a-vA-V](_?[0-9a-vA-V])*|33[|][0-9a-wA-W](_?[0-9a-wA-W])*|34[|][0-9a-xA-X](_?[0-9a-xA-X])*|35[|][0-9a-yA-Y](_?[0-9a-yA-Y])*|36[|][0-9a-zA-Z](_?[0-9a-zA-Z])*))/
				);
				if (numberBaseRange) {
					const word = document.getText(numberBaseRange);
					const [n_base, value] = word.split('|');
					const base = parseInt(n_base.split('n')[1]);
					return new vscode.Hover(
						new vscode.MarkdownString()
							.appendCodeblock(word)
							.appendMarkdown(`### Literal Numerico 🔢\n`)
							.appendText(`Base: ${base}\nValor: ${parseInt(value.replaceAll('_', ''), base)}`)
					);
				}
				const numberOtherBase = document.getWordRangeAtPosition(position, /(0b[01](_?[01])*)|(0o[0-7]+)|(0d[0-9]+)|(0x[0-9a-fA-F]+)/);
				if (numberOtherBase) {
					const word = document.getText(numberOtherBase);
					let base;
					if (word.startsWith('0b')) {
						base = 2;
					} else if (word.startsWith('0o')) {
						base = 8;
					} else if (word.startsWith('0d')) {
						base = 10;
					} else if (word.startsWith('0x')) {
						base = 16;
					}
					return new vscode.Hover(
						new vscode.MarkdownString()
							.appendCodeblock(word)
							.appendMarkdown(`### Literal Numerico 🔢\n`)
							.appendText(`Base: ${base}\nValor: ${parseInt(word.substring(2).replaceAll('_', ''), base)}`)
					);
				}
				const numberDecimal = document.getWordRangeAtPosition(position, /([0-9]+[0-9_]*(?:\.[0-9]+[0-9_]*)?)/);
				if (numberDecimal) {
					const word = document.getText(numberDecimal);
					return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(word).appendMarkdown(`### Literal Numerico 🔢\n`));
				}
			},
		});
		context.subscriptions.push(
			diagnostics,
			onCloseFile,
			onSaveFile,
			onOpenFile,
			onChangeActive,
			semanticTokensProvider,
			definitionProvider,
			renameProvider,
			completionItemProvider,
			hoverProvider
		);
	},
};
