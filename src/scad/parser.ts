import { makeRule, Rules, MaybeList, terminal, Forward, TextPos, WithPrec, makeParser} from '@isopodlabs/tison';
import { Binary, Unary, Conditional, Literal, Call, Identifier } from '@isopodlabs/tison/ast'

/** How `use`/`include` reach the file system, as OpenSCAD's lexer does for itself (`find_valid_path` then
 *  `fopen`). Injectable so this module needs no `fs`: with none, every `use`/`include` resolves to nothing,
 *  exactly as a file that isn't there does. */
export interface FileAccess {
	/** The path to read for `path` written in `fromDir`, or undefined if there is no such file. */
	resolve(path: string, fromDir: string): string | undefined;
	read(fullpath: string): string;
}

const ID		= terminal('id', /[a-zA-Z_$][a-zA-Z0-9_]*/);
const STRING	= /"(?:[^"\\]|\\.)*"/;
// OpenSCAD's lexer.l accepts a leading-digit form (5, 5., 5.5) and a leading-dot form (.5) as separate rules; this
// is both in one, since the two never overlap (the second alternative needs a digit right after the dot, so it
// never eats a bare '.', which is the member-access operator).
const NUMBER = /(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?[fFlL]?/;

// The text between the angle brackets of a `use`/`include`, and the directory part of a path.
const pathOf = (match: string) => match.slice(match.indexOf('<') + 1, -1);
const dirOf  = (file: string) => file.replace(/[\\/][^\\/]*$/, '');

// OpenSCAD's escapes are C-like, not JSON (it also has \xNN and \u{...}), so the rule action decodes them itself.
const unescape = (s: string) => s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);

// `use`/`include` are keywords only in front of a `<path>`: OpenSCAD's lexer has a state for each
// (lexer.l's cond_use/cond_include), so with none the word falls through to its ID rule.
const USE		= terminal('use', /use[ \t\r\n]*<[^\t\r\n>]+>/, (lex, ctx: Ctx) => ({type: USE, value: ctx.libraryPath(pathOf(lex.match)), pos: lex}));
// `include` is not a path pair in the grammar either: the lexer hands `statement` the whole construct, and
// that statement splices the file in -- the one place OpenSCAD does it from (see `spliceInclude`).
const INCLUDE	= terminal('include', /include[ \t\r\n]*<[^\t\r\n>]+>/, lex => ({type: INCLUDE, value: pathOf(lex.match), pos: lex}));

// bison: `%nonassoc NO_ELSE` below `%nonassoc TOK_ELSE`. A reduce that ends an `if` without its else
// (NO_ELSE) loses to shifting that `else` (TOK_ELSE), so an `else` binds to the nearest `if`.
const PREC = {
	noElse: {assoc: 'nonassoc'},
	'else': {assoc: 'nonassoc'},
} as const;

export interface Location { filename: string; line: number, col: number }

export function stampLoc<T>(t: T, $: {pos: TextPos}, ctx: Ctx): T {
	return typeof t === 'object' && t !== null
		? Object.defineProperty(t, 'loc', {value: {filename: ctx.currfile.path, line: $.pos.line, col: $.pos.col}, enumerable: false, configurable: true, writable: false })
		: t;
}

export function getLoc(node: unknown): Location | undefined {
	return (node as {loc?: Location})?.loc;
}

export interface Assignment {
	name:	string;
	expr?:	Expr;
};

export class UserModule {
	body	= new LocalScope;
	constructor(public name: string, public parameters: Assignment[]) {
	}
}

export class UserFunction {
	constructor(public name: string, public parameters: Assignment[], public expr: Expr) {}
};

export class LocalScope {
	assignments:			Assignment[] = [];
  	moduleInstantiations:	ModuleInstantiation[] = [];
	functions	= new Map<string, UserFunction>;
	modules		= new Map<string, UserModule>;

	addModuleInst(mod: ModuleInstantiation) { this.moduleInstantiations.push(mod); }
	addModule(mod: UserModule)				{ this.modules.set(mod.name, mod); }
	addFunction(func: UserFunction)			{ this.functions.set(func.name, func); }
	addAssignment(ass: Assignment)			{ this.assignments.push(ass); }
	hasChildren() 							{ return this.moduleInstantiations.length > 0; }
};

export class ModuleInstantiation {
	scope				= new LocalScope;
	tag_root?:			boolean;
	tag_highlight?: 	boolean;
	tag_background?:	boolean;

	constructor(public modname?: string, public args?: Assignment[]) {
	}
}

export class IfElseModuleInstantiation extends ModuleInstantiation {
	else_scope = new LocalScope;

	constructor(public expr: Expr) {
		super();
	}
}

export class SourceFile {
	scope		= new LocalScope;
	includes	= new Map<string, string>;
	usedlibs:	string[]	= [];
//	indicatorData:	IndicatorData[];

	constructor(public path: string) {}
	registerUse(path: string, loc: Location) {
		const at = this.usedlibs.indexOf(path);
		if (at >= 0)
			this.usedlibs.splice(at, 1);
		this.usedlibs.unshift(path);		// most recent first, as SourceFile::registerUse does
	}
	registerInclude(localpath: string, fullpath: string, loc: Location) {
		if (this.includes.has(localpath))
			return false;
		this.includes.set(localpath, fullpath);
		return true;
	}
};

export type unaryOps	= '+'|'-'|'~'|'!';
export type binaryOps	= ','|'+'|'-'|'*'|'/'|'%'|'^'|'<<'|'>>'
						| '&&'|'||'|'&'|'|'
						|'<'|'>'|'<='|'>='|'=='|'!='


export interface FunctionDefinition {
	type: 'funcdef';
	expr: Expr;
	args: Assignment[];
}

export interface ArrayLookup {
	type: 'arraylookup';
	array: Expr;
	index: Expr;
}

export interface Range {
	type:'range';
	begin: Expr;
	step?: Expr;
	end: Expr;
}

export interface MemberLookup {
	type: 'memberlookup';
	expr: Expr;
	member: string;
}

export interface FunctionCall {
	type: 'functioncall';
	name: string;
	expr: Expr;
	arguments: Assignment[];
}

export interface Assert {
	type: 'assert';
	expr?: Expr;
	arguments: Assignment[];
}

export interface Echo {
	type: 'echo';
	expr?: Expr;
	arguments: Assignment[];
}

export interface Let {
	type: 'let';
	expr: Expr;
	arguments: Assignment[];
}

export interface LcIf {
	type: 'lcif';
	cond: Expr;
	ifexpr: Expr;
	elseexpr?: Expr;
}

export interface LcFor {
	type: 'lcfor';
	args: Assignment[];
//	cond: Expr;
	expr: Expr;
}

export interface LcForC {
	type: 'lcforc';
	args: Assignment[];
	incrargs: Assignment[];
	cond: Expr;
	expr: Expr;
}

export interface LcEach {
	type: 'lceach';
	expr: Expr;
}

export interface LcLet {
	type: 'lcletp';
	args: Assignment[];
	expr: Expr;
}

export interface Vector {
	type: 'vector';
	value: Expr[];
}

export type Expr =
	| Literal<boolean | number | string | undefined>
	| Identifier
	| Binary<Expr, binaryOps>
	| Unary<Expr, unaryOps>
	| Conditional<Expr>
	| Call<Expr, Assignment>
	| Vector
	| FunctionDefinition
	| ArrayLookup
	| Range
	| MemberLookup
	| FunctionCall
	| Assert
	| Echo
	| Let
	| LcIf
	| LcFor
	| LcForC
	| LcEach
	| LcLet;


class Ctx {
	scope_stack:	LocalScope[] = [];
	file_stack:		SourceFile[];
	fileEnded = false;

	get top()		{ return this.scope_stack.at(-1)!; }
	get currfile()	{ return this.file_stack.at(-1)!; }
	get rootfile()	{ return this.file_stack[0]; }

	constructor(public mainFilePath: string, public files?: FileAccess) {
		this.file_stack = [new SourceFile(mainFilePath)];
	}

	/** The path to read for `written`, or undefined when there is no such file or it is already being spliced
	 *  -- lexer.l's `check_valid` refuses a path in its open-file list, which is what stops a circular include. */
	private openTarget(written: string) {
		return this.files?.resolve(written, dirOf(this.currfile.path));
	}

	// OpenSCAD resolves a `use` target in the lexer and carries the resolved path as the token's value, falling
	// back to the name as written when it can't (SourceFile::handleDependencies relocates it later).
	libraryPath(written: string) {
		const fullpath = this.openTarget(written);
		if (this.files && !fullpath)
			console.warn(`WARNING: Can't open library '${written}'`);
		return fullpath ?? written;
	}

	/** Splice `include`'s file in where the statement is, in the scope it is in: OpenSCAD's lexer does this by
	 *  pushing the file as a new input buffer, so its statements are parsed as if they had been typed in place.
	 *  A nested parse into the same rootfile and scope is this engine's equivalent of that buffer push. */
	spliceInclude(written: string, loc: Location) {
		const fullpath	= this.openTarget(written);
		if (this.rootfile.registerInclude(written, fullpath ?? written, loc)) {
			const files		= this.files;
			if (!files || !fullpath) {
				if (files)
					console.warn(`WARNING: Can't find include file '${written}'`);
				return;
			}
			const text	= files.read(fullpath);
			const file	= new SourceFile(fullpath);
			this.file_stack.push(file);
			this.scope_stack.push(file.scope);
			lalr.parse(text, this);
			this.scope_stack.pop();
			this.file_stack.pop();
		}
	}

	assign(token: string, expr: Expr, loc: Location) {
		const currFile = this.currfile;
		const mainFile = this.rootfile;
		for (const assignment of this.top.assignments) {
			if (assignment.name == token) {
				const assloc = getLoc(assignment)!;
				const prevFile = assloc.filename;

				if (this.fileEnded) {
					//assignments via commandline
				} else if (prevFile == mainFile.path && currFile == mainFile) {
					//both assignments in the mainFile
					warn_reassignment(loc, assignment, mainFile.path);
				} else if (currFile == mainFile) {
					//assignment overwritten within the same file - the line number being equal happens, when a file is included multiple times
					if (assloc.line != loc.line)
						warn_reassignment(loc, assignment, mainFile.path, mainFile.path);
				} else if (prevFile == mainFile.path && currFile != mainFile) {
					//assignment from the mainFile overwritten by an include
					warn_reassignment(loc, assignment, mainFile.path, mainFile.path);
				}
				assignment.expr = expr;
				//assignment->setLocationOfOverwrite(loc);
				return;
			}
		}
		// this assignment's own loc is what a *later* reassignment of the same name looks up above (via getLoc) to
		// report where it was first assigned -- stamped the same way stampLoc() marks every other parsed node, since
		// this one object literal isn't built through the grammar's own stampLoc-wrapped Rule() constructor
		this.top.addAssignment(Object.defineProperty({name: token, expr}, 'loc', {value: loc, enumerable: false, configurable: true, writable: false}));
	}
}

const Rule = makeRule<Ctx>(stampLoc);


const fwd_child_statement				= Forward<ModuleInstantiation>(() => child_statement);
const fwd_expr							= Forward<Expr>(() => expr);
const fwd_logic_or						= Forward<Expr>(() => logic_or);
const fwd_vector_element				= Forward<Expr>(() => vector_element);

function warn_reassignment(loc: Location, ass: Assignment, mainFilePath: string, uncPathPrev?: string) {
	console.warn(`WARNING: Reassignment of variable ${ass.name} at ${loc.filename}:${loc.line}`);
}

const parameter = Rules<Assignment>(
	Rule([ID],	$ => ({ name: $[0] })),
	Rule([ID, '=', fwd_expr],	$ => ({name: $[0], expr: $[2]})),
);
const parameters = MaybeList(parameter, ',', true);

const assignment = Rules(
	Rule([ID, '=', fwd_expr, ';'],	($, ctx) => ctx.assign($[0], $[2], {...$.pos, filename: ctx.currfile.path}))
);

const statement = Rules<void>(self => [
	Rule([';']),
	Rule(['{', MaybeList(self), '}']),
	Rule([Forward<ModuleInstantiation>(() => module_instantiation)],	($, ctx) => {
		if ($[0])
			ctx.top.addModuleInst($[0]);
	}),
	Rule([assignment]),
	Rule(['module', ID, '(', parameters, ')',	($, ctx) => {
			const mod = new UserModule($[1], $[3]);
			const top = ctx.top;
			ctx.scope_stack.push(mod.body);
			top.addModule(mod);
		},
		self],
		($, ctx) => ctx.scope_stack.pop()
	),
	Rule(['function', ID, '(', parameters, ')', '=', fwd_expr, ';'],
		($, ctx) => ctx.top.addFunction(new UserFunction($[1], $[3], $[6]))),
	Rule([INCLUDE],
		($, ctx) => ctx.spliceInclude($[0], {...$.pos, filename: ctx.currfile.path})),
]);

const if_statement = Rules(
	Rule(['if', '(', fwd_expr, ')',	($, ctx) => {
			const ifelse = new IfElseModuleInstantiation($[2]);
			ctx.scope_stack.push(ifelse.scope);
			return ifelse;
		},
		fwd_child_statement],	($, ctx) => {
			ctx.scope_stack.pop();
			return $[4];
		}),
);

const module_instantiation = Rules<ModuleInstantiation|null>(self => [
	Rule(['!', self],	$ => {
		if ($[1])
			$[1].tag_root = true;
			return $[1];
	}),
	Rule(['#', self],	$ => {
		if ($[1])
			$[1].tag_highlight = true;
			return $[1];
	}),
	Rule(['%', self],	$ => {
		if ($[1])
			$[1].tag_background = true;
			return $[1];
	}),
	Rule(['*', self],	_ => null as unknown as ModuleInstantiation),
	Rule([Forward<ModuleInstantiation>(() => single_module_instantiation),	($, ctx) => {
			ctx.scope_stack.push($[0].scope);
			return $[0];
		},
		fwd_child_statement],	($, ctx) => {
			ctx.scope_stack.pop();
			return $[1];
		}),
	WithPrec(Rule([if_statement]), PREC.noElse),
	WithPrec(Rule([if_statement, 'else', ($, ctx) => {
			ctx.scope_stack.push($[0].else_scope);
		},
		fwd_child_statement],	($, ctx) => {
			ctx.scope_stack.pop();
			return $[0];
		}), PREC.else)
]);

const child_statements = Rules(self => [
	Rule([/*, empty, */]),
	Rule([self, fwd_child_statement]),
	Rule([self, assignment]),
]);

const child_statement = Rules<void>(
	Rule([';']),
	Rule(['{', child_statements, '}']),
	Rule([module_instantiation],	($, ctx) => {
		if ($[0])
				ctx.top.addModuleInst($[0]);
	}),
);

const argument = Rules(
	Rule([fwd_expr],			$ => ({ name: "", expr: $[0] })),
	Rule([ID, '=', fwd_expr],	$ => ({ name: $[0], expr: $[2] })),
);
const arguments_ = MaybeList(argument, ',', true);

// "for", "let" and "each" are valid module identifiers
const module_id = Rules(
	Rule([ID]),
	Rule(['for']),
	Rule(['let']),
	Rule(['assert']),
	Rule(['echo']),
	Rule(['each']),
);

const single_module_instantiation = Rules(
	Rule([module_id, '(', arguments_, ')'],	$ => new ModuleInstantiation($[0], $[2])),
);


const expr_or_empty = Rules(
	Rule([/*, empty, */],	_ => undefined),
	fwd_expr
);

const expr = Rules<Expr>(self => [
	fwd_logic_or,
	WithPrec(Rule(['function', '(', parameters, ')', self],	$ => ({ type: 'funcdef', expr: $[4], args: $[2] })), PREC.noElse),
	Rule([fwd_logic_or, '?', self, ':', self],				$ => Conditional($[0], $[2], $[4])),
	Rule(['let', '(', arguments_, ')', self],				$ => ({ type: 'let', expr: $[4], arguments: $[2] })),
	Rule(['assert', '(', arguments_, ')', expr_or_empty],	$ => ({ type: 'assert', expr: $[4], arguments: $[2] })),
	Rule(['echo', '(', arguments_, ')', expr_or_empty],		$ => ({ type: 'echo', expr: $[4], arguments: $[2] })),
]);

const primary = Rules<Expr>(
	Rule(['true'],		_ => Literal(true)),
	Rule(['false'],		_ => Literal(false)),
	Rule(['undef'],		_ => Literal(undefined)),
	Rule([NUMBER],		$ => Literal(parseFloat($[0]))),
	Rule([STRING],		$ => Literal(unescape($[0]))),
	Rule([ID],			$ => Identifier($[0])),
	Rule(['(', expr, ')'],							$ => $[1]),
	Rule(['[', expr, ':', expr, ']'],				$ => ({ type: 'range', begin: $[1], end: $[3], step: undefined })),
	Rule(['[', expr, ':', expr, ':', expr, ']'],	$ => ({ type: 'range', begin: $[1], step: $[3], end: $[5] })),	// OpenSCAD's order is [begin : step : end]
//	Rule(['[', ']'],								_ => ({ type: 'vector', value: []})),
	Rule(['[', MaybeList(fwd_vector_element, ',', true), ']'], $ => ({type: 'vector', value: $[1]}))
);

const call = Rules<Expr>(self => [
	primary,
	Rule([self, '(', arguments_, ')'],	$ => Call($[0], $[2])),
	Rule([self, '[', expr, ']'],					$ => ({ type: 'arraylookup', array: $[0], index: $[2] })),
	Rule([self, '.', ID],							$ => ({ type: 'memberlookup', expr: $[0], member: $[2] })),
]);

const unary = Rules<Expr>(self =>[
	Forward<Expr>(() => exponent),
	Rule(['+', self],	$ => $[1]),
	Rule(['-', self],	$ => $[1].type === 'literal' && typeof $[1].value === 'number'
		? Literal(-$[1].value)
		: Unary($[0], $[1])
	),
	Rule(['!', self],	$ => Unary($[0], $[1])),
	Rule(['~', self],	$ => Unary($[0], $[1])),
]);

const exponent = Rules(
	call,
	Rule([call, '^', unary],	$ => Binary($[1], $[0], $[2])),
);

const multiplication = Rules(self => [
	unary,
	Rule([self, '*', unary],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '/', unary],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '%', unary],	$ => Binary($[1], $[0], $[2]) as Expr),
]);


const addition = Rules(self => [
	multiplication,
	Rule([self, '+', multiplication],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '-', multiplication],	$ => Binary($[1], $[0], $[2]) as Expr),
]);


const shift = Rules(self => [
	addition,
	Rule([self, '<<', addition],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '>>', addition],	$ => Binary($[1], $[0], $[2]) as Expr),
]);

const binaryand = Rules(self => [
	shift,
	Rule([self, '&', shift],		$ => Binary($[1], $[0], $[2]) as Expr),
]);

const binaryor = Rules(self => [
	binaryand,
	Rule([self, '|', binaryand],	$ => Binary($[1], $[0], $[2]) as Expr),
]);

const comparison = Rules(self => [
	binaryor,
	Rule([self, '>', binaryor],		$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '>=', binaryor],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '<', binaryor],		$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '<=', binaryor],	$ => Binary($[1], $[0], $[2]) as Expr),
]);

const equality = Rules(self => [
	comparison,
	Rule([self, '==', comparison],	$ => Binary($[1], $[0], $[2]) as Expr),
	Rule([self, '!=', comparison],	$ => Binary($[1], $[0], $[2]) as Expr),
]);

const logic_and = Rules(self => [
	equality,
	Rule([self, '&&', equality],	$ => Binary($[1], $[0], $[2]) as Expr),
]);

const logic_or = Rules(self => [
	logic_and,
	Rule([self, '||', logic_and],	$ => Binary($[1], $[0], $[2])),
]);

/* The last set element may not be a "let" (as that would instead be parsed as an expression) */
const list_comprehension_elements = Rules<Expr>(self => [
	Rule(['let', '(', arguments_, ')', self],												$ => ({type: 'let', expr: $[4], arguments: $[2] })),
	Rule(['each', fwd_vector_element],														$ => ({type: 'lceach', expr: $[1] })),
	Rule(['for', '(', arguments_, ')', fwd_vector_element],									$ => ({type: 'lcfor', args: $[2], expr: $[4] })),
	Rule(['for', '(', arguments_, ';', expr, ';', arguments_, ')', fwd_vector_element],		$ => ({type: 'lcforc', args: $[2], cond: $[4], incrargs: $[6], expr: $[8] })),
	WithPrec(Rule(['if', '(', expr, ')', fwd_vector_element],								$ => ({type: 'lcif', cond: $[2], ifexpr: $[4], elseexpr: undefined })), PREC.noElse),
	WithPrec(Rule(['if', '(', expr, ')', fwd_vector_element, 'else', fwd_vector_element],	$ => ({type: 'lcif', cond: $[2], ifexpr: $[4], elseexpr: $[6] })), PREC.else),
]);

const vector_element = Rules(
	list_comprehension_elements,
	Rule(['(', list_comprehension_elements, ')'],	$ => $[1]),
	expr,
);

//const vector_elements = Rules(
//	Rule([vector_element],
//		$ => {
//			return {type: 'vector', value: [$[0]]};
//		}),
//	Rule([fwd_vector_elements, ',', vector_element],
//		$ => {
//			$[0].value.push($[2]);
//			return $[0];
//		}),
//);

//const parameters = Rules(
//	Rule([/*, empty, */],
//		_ => {
//			return [];
//		}),
//	Rule([fwd_parameter_list, optional_trailing_comma]),
//);

//const parameter_list = Rules(
//	Rule([fwd_parameter],
//		$ => {
//			return [$[0]];
//		}),
//	Rule([fwd_parameter_list, ',', fwd_parameter],
//		$ => {
//			$[0].push($[2]);
//			return $[0];
//		}),
//);

/*
const argument_list = Rules(
	Rule([fwd_argument],	$ => [$[0]]),
	Rule([fwd_argument_list, ',', fwd_argument],	$ => {
			$[0].push($[2]);
			return $[0];
		}),
);
*/
//const arguments_ = Rules(
//	Rule([/*, empty, */],
//		_ => {
//			return [];
//		}),
//	Rule([argument_list, optional_trailing_comma]),
//);

const input = Rules<void>(self => [
	Rule([]),
	Rule([self, USE], ($, ctx) => ctx.rootfile.registerUse($[1], {...$.pos, filename: ctx.currfile.path})),
	Rule([self, statement])
]);

const lalr = makeParser({
	precedence: PREC,
	skip: [/\s+/, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	start: input,
});

/** Parse `code` as one .scad file, splicing whatever it `include`s through `files`, and return the file the
 *  rules registered into. Nothing here is asynchronous: bison's driver owns the context (its `parse` pushes
 *  the root scope and pops it again), and an `include` is expanded where it is read, with no I/O to await. */
export const parser = {
	tables: lalr.tables,
	parse(code: string, filename = 'main.scad', files?: FileAccess): SourceFile {
		const ctx = new Ctx(filename, files);
		ctx.scope_stack.push(ctx.rootfile.scope);
		lalr.parse(code, ctx);
		return ctx.rootfile;
	},
};

// Phase 2. `read` gives a file's text, or undefined if it isn't there -- so the grammar module never
// imports `fs`, and a caller can pass a Map (tests) or readFileSync (node).
export function parse(code: string, filename = 'main.scad', files?: FileAccess): SourceFile {
	const ctx = new Ctx(filename, files);
	const parseOne = (text: string, file: SourceFile) => {
		ctx.file_stack.push(file);								// stampPos/registerUse record the right file
		ctx.scope_stack.push(file.scope);
		lalr.parse(text, ctx);
		ctx.scope_stack.pop();
		ctx.file_stack.pop();
	};
	parseOne(code, ctx.rootfile);
	if (files)
		for (const [, full] of ctx.rootfile.includes) {		// Map iterators see entries added while iterating,
			const text = files.read(full);						// so nested includes drain in the same loop
			if (!text)
				throw new Error(`Missing included file: ${full}`);
			parseOne(text, new SourceFile(full));
		}
	return ctx.rootfile;
}