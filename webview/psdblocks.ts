// The vector side of a PSD layer, from the layer's tagged blocks as the PSD package reads them (Layer.blocks). A shape layer is
// a fill (a colour, gradient or pattern) seen through a vector mask: the paths of its 'vmsk' (or 'vsms') block. This turns
// those paths into the point editor's curves and back; the package reads and writes the blocks themselves.
//
// A path is a list of records: a subpath is a length record followed by that many knots, each the anchor and the control
// points before and after it, as fractions of the canvas.

import type { psd } from '@isopodlabs/binary_bitmaps';

type DeepPartial<T> = T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? {[K in keyof T]?: DeepPartial<T[K]>} : T;

export type Value		= psd.DescriptorValue;
export type LayerBlocks = psd.LayerBlocks;
export type PathRecord	= psd.PathRecord;

export type EngineValue	= psd.EngineValue;
export type EngineDict	= Record<string, EngineValue>;

//-----------------------------------------------------------------------------
//	specs
//-----------------------------------------------------------------------------

export interface Access0<T, U> {
	from:	(value?: U) => T | undefined,
	to:		(value: T) => U | undefined,
}
export type Entry0<V, T>	= [string, Access0<T, V>];
export type Specs0<V>		= Record<string, Entry0<V, any>>;

export type AccessOf<S extends Access0<any, any>> = S extends Access0<infer T, any> ? T : never;
export type SpecOf<S extends Specs0<any>> = {[K in keyof S]: S[K] extends Entry0<any, infer T> ? T : never};

// helper for creating entries
export function E<T, V>(name: string, a: Access0<T, V>): Entry0<V, T> { return [name, a]; }

export function Post<V extends Value | EngineValue, T, U>(a: Access0<T, V>, conv: {from: (value: T) => U | undefined, to: (value: U) => T}): Access0<U, V> {
	return {
		from:	(v?: V)	=> { const t = a.from(v); return t === undefined ? undefined : conv.from(t); },
		to:		(v: U)	=> a.to(conv.to(v))
	};
}

export const Scale = <V extends Value | EngineValue>(a: Access0<number, V>, factor: number) => Post(a, { from: v => v / factor, to: v => v * factor})

/** An access that reads this when the item is missing. */
export function Default<V extends Value | EngineValue, T>(a: Access0<T, V>, value: T): Access0<T, V> {
	return {from: (v: any) => a.from(v) ?? value, to: a.to};
}

/** An access for a field that may be absent: it is not written when undefined, and is read as undefined when the item is missing. */
export function Optional<V extends Value | EngineValue, T>(a: Access0<T, V>): Access0<T | undefined, V> {
	return {
		from:	(v?: V) => v === undefined ? undefined : a.from(v),
		to:		(v: any) => v === undefined ? undefined : a.to(v)
	};
}

export function withSpec<V extends Value | EngineValue, S extends Specs0<V>>(spec: S, items: Record<string, V>) : SpecOf<S> {
	const m: PropertyDescriptorMap = Object.fromEntries(Object.entries(spec).map(([k, [name, v]]) => [k, {
		enumerable: true,
		get() {
			return v.from(items[name]);
		},
		set(x: any) {
			const r = v.to(x);
			if (r)
				items[name] = r;
		}
	}]));
	return Object.defineProperties({} as any, m);
}

//-----------------------------------------------------------------------------
//	descriptor values
//-----------------------------------------------------------------------------

export type Items		= Record<string, Value>;
export type Access<T>	= Access0<T, Value>;
export type Specs		= Specs0<Value>;

const descriptor		= (classId: string, items: Items): psd.Descriptor => ({name: '', classId, items});
const obj				= (classId: string, items: Items): Value => ({type: 'Objc', value: descriptor(classId, items)});
const makeArray			= (value: Value[]): Value => ({type: 'VlLs', value});
const enumOf			= (typeId: string, value: string): Value => ({type: 'enum', typeId, value});
const unit				= (unit: string) => (value: number): Value => ({type: 'UntF', unit, value});

const getObj			= (value?: Value) => value?.type === 'Objc' ? value.value : value?.type === 'GlbO' ? value.value : undefined;
const getArray			= (value?: Value) => value?.type === 'VlLs' ? value.value : [];
const getNumber			= (value?: Value) => value?.type === 'UntF' && value.unit === '#Prc' ? value.value / 100 : typeof value?.value == 'number' ? value.value : undefined;
const getBool			= (value?: Value) => value?.type === 'bool' && value.value !== false;

export const items		= (v?: Value) => getObj(v)?.items;
export const list		= (v?: Value) => getArray(v).map(items).filter((i): i is Items => !!i);
export const one		= <T>(value: Value | undefined, read: (i: Items) => T | undefined): T | undefined => {
	const o = getObj(value);
	return o && read(o.items);
};
export const fromList	= (multi?: Value, single?: Value) => !items(single) || list(multi).some(i => getBool(i.enab));

export const Bool 		= { from: getBool, to: (value: boolean): Value => ({type: 'bool', value}) };
export const Double		= { from: getNumber, to: (value: number): Value => ({type: 'doub', value}) };
export const Percent	= { from: getNumber, to: (value: number): Value => ({type: 'UntF', unit: '#Prc', value: value * 100}) };
export const Long		= { from: getNumber, to: (value: number): Value => ({type: 'long', value}) };

export const Engine		= {
	from: (value?: Value) => value?.type === 'tdta' ? value.value : undefined,
	to: (value: EngineDict): Value => ({type: 'tdta', value})
};

/** An object of this class: a descriptor of another class (a colour of another model, say) is not read. */
export const Obj	= <S extends Specs>(classId: string, spec: S) => ({
	from:	(v?: Value) => { const o = getObj(v); return o?.classId === classId ? readSpec(spec, o.items) : undefined; },
	to:		(v: Partial<SpecOf<S>>): Value => obj(classId, writeSpec(spec, v))
});
export const Descriptor	= <S extends Specs>(classId: string, spec: S) => ({
	from:	(v?: psd.Descriptor)	=> v?.classId === classId ? readSpec(spec, v.items) : undefined,
	to:		(v: Partial<SpecOf<S>>) => descriptor(classId, writeSpec(spec, v))
});

/** Fields kept among the items of the descriptor itself, as an object of their own. */
export const Merge	= <S extends Specs>(spec: S): Entry0<Value, SpecOf<S>> => E('', Obj('', spec));

/** A list of objects. */
export const List	= <T>(a: Access<T>) => ({
	from:	(v?: Value): T[] => getArray(v).map(x => a.from(x)).filter((x): x is T => x !== undefined),
	to:		(v: T[]): Value => makeArray(v.map(x => a.to(x)).filter((x): x is Value => !!x))
});
/** One item of an object, for fields that are parts of an object that others are parts of too (an object of this class holding only this item
 *  is what is written, and writing several of them together puts them in one). */
export const Within	= <T>(classId: string, name: string, a: Access<T>): Access<T> => ({
	from:	v => one(v, i => a.from(i[name])),
	to:		x => { const w = a.to(x); return w && obj(classId, {[name]: w}); }
});
/** A bool that is the default unless the file says otherwise. */
export const BoolOr	= (value: boolean): Access<boolean> => ({from: v => v?.type === 'bool' ? v.value : value, to: (value: boolean): Value => ({type: 'bool', value})});

/** An enum kept as its own name (for the kinds that are not listed). */
export const Enum		= (typeId: string): Access<string> => ({from: v => v?.type === 'enum' ? v.value : undefined, to: v => enumOf(typeId, v)});
export const Text		= {from: (v?: Value) => typeof v?.value == 'string' ? v.value : undefined, to: (value: string): Value => ({type: 'TEXT', value})};

/** One of two kinds of object, told apart by which of them reads it (each refuses what is not its own). */
export const Union		= <A, B>(a: Access<A>, b: Access<B>, isA: (v: A | B) => v is A): Access<A | B> => ({
	from:	v => a.from(v) ?? b.from(v),
	to:		v => isA(v) ? a.to(v) : b.to(v as B)
});

export const Lookup		= <const K extends string, const V>(typeId: string, table: Record<K, V>): Access<V> => ({
	from:	v => typeof v?.value == 'string' ? (table[v.value as K] ?? table[v.value.trim() as K]) : undefined,
	to:		v => enumOf(typeId, Object.entries(table).find(([k, v2]) => v === v2)?.[0] ?? '')
});

export const Unit		= (unit: string, factor = 1) => ({
	from: (v: Value | undefined) => {
		if (v?.type === 'UntF')
			return v.unit === unit ? v.value * factor : v.value;
		return typeof v?.value == 'number' ? v.value : undefined;
	},
	to: (v: number): Value => ({type: 'UntF', unit, value: v / factor})
});


//-----------------------------------------------------------------------------
//	descriptor read/write
//-----------------------------------------------------------------------------

export function readSpec<S extends Specs>(spec: S, items: Items) : SpecOf<S> {
	const out = {} as any;
	for (const [k, [name, v]] of Object.entries(spec))
		out[k] = v.from(name ? items[name] : obj('', items));
	return out;
}

/** The items for an object; a field whose access writes nothing (undefined) is left out. */
export function writeSpec<S extends Specs>(spec: S, value: Partial<SpecOf<S>>) : Items {
	const items = {} as Items;
	for (const [k, [name, v]] of Object.entries(spec)) {
		const field = (value as any)[k];
		const written = field === undefined ? undefined : v.to(field);
		if (written) {
			if (name)
				merge(items, {[name]: written});		// (fields that are parts of one object are written together)
			else
				merge(items, getObj(written)?.items ?? {});
		}
	}
	return items;
}

/** Written items put over the ones a descriptor has: an object of the same class is merged into, item by item, so what the file keeps
 *  of it that was not written stays; anything else (a list, a number) replaces. */
export function merge(into: Items, written: Items): Items {
	for (const [k, v] of Object.entries(written)) {
		const was = getObj(into[k]), now = getObj(v);
		if (was && now && was.classId === now.classId)
			merge(was.items, now.items);
		else
			into[k] = v;
	}
	return into;
}

/** Default items put in a descriptor where it has none of its own (what it has is left as it is, objects of the same class being filled in the same way). */
export function fill(into: Items, defaults: Items): Items {
	for (const [k, v] of Object.entries(defaults)) {
		const was = getObj(into[k]), now = getObj(v);
		if (!(k in into))
			into[k] = v;
		else if (was && now && was.classId === now.classId)
			fill(was.items, now.items);
	}
	return into;
}

/** An object written over the items a descriptor has (a field of the object that is undefined is left as the descriptor has it). */
export function put<S extends Specs>(into: Items, spec: S, value: Partial<SpecOf<S>>): Items {
	return merge(into, writeSpec(spec, value));
}

/** A list of written objects put over the list a descriptor has: the ones that are there already are merged into, the rest are new. */
export function mergeList(was: Value | undefined, written: Value): Value {
	const old = getArray(was);
	return makeArray(getArray(written).map((w, k) => {
		const a = getObj(old[k]), b = getObj(w);
		if (a && b && a.classId === b.classId) {
			merge(a.items, b.items);
			return old[k];
		}
		return w;
	}));
}

export function writeWith<B extends psd.LayerBlock & {descriptor: psd.Descriptor0}>(blocks: psd.LayerBlocks, block: B | undefined, write: (i: Items)=>void): psd.LayerBlocks {
	if (!block)
		return blocks;
	const copy	= structuredClone(block);
	write(copy.descriptor.items);
	return {...blocks, [block.key]: copy};
}

/** The blocks with a change to the items of one of a block's descriptors (a text layer's has two: its `text` and its `warp`). */
export function writeField<B extends {key: string}>(blocks: psd.LayerBlocks, block: B | undefined, field: keyof B & string, write: (i: Items) => void): psd.LayerBlocks {
	if (!block)
		return blocks;
	// (a copy of the field's items only: the rest of the block, which can hold things that cannot be cloned, is shared)
	const was = block[field] as psd.Descriptor0, items = {...was.items};
	write(items);
	return {...blocks, [block.key]: {...block, [field]: {...was, items}}};
}

//-----------------------------------------------------------------------------
//	engine data values
//-----------------------------------------------------------------------------

export type EngineSpecs 	= Specs0<EngineValue>;
export type EngineAccess<T> = Access0<T, EngineValue>;
export const isDict = (v: unknown): v is EngineDict => typeof v === 'object' && v !== null && !Array.isArray(v) && !('token' in v) && !('name' in v);

/** A real number as the engine data writes it: with a decimal point, so that it is not taken for an integer. */
export const real = (value: number): psd.EngineToken => ({
	token: Number.isInteger(value) ? value.toFixed(1) : String(+value.toFixed(5)).replace(/^(-?)0\./, '$1.'),
});

// The parser keeps a number or a boolean as the text it was, which is read only when a field asks for it (and written back untouched when none does).
const tokenOf	= (v?: EngineValue) => typeof v === 'object' && v !== null && 'token' in v ? (v as psd.EngineToken).token : undefined;
const numberOf	= (v?: EngineValue) => { const n = typeof v === 'number' ? v : tokenOf(v) === undefined ? NaN : Number(tokenOf(v)); return Number.isNaN(n) ? undefined : n; };

export const Real	= {from: numberOf, to: (value: number): EngineValue => real(value)};
export const Int	= {from: numberOf, to: (value: number): EngineValue => Math.round(value)};
export const Flag	= {
	from:	(v?: EngineValue) => typeof v === 'boolean' ? v : tokenOf(v) === 'true' ? true : tokenOf(v) === 'false' ? false : undefined,
	to:		(value: boolean): EngineValue => value
};
export const Reals	= {
	from:	(v?: EngineValue) => Array.isArray(v) ? v.map(numberOf).filter((n): n is number => n !== undefined) : undefined,
	to:		(value: number[]): EngineValue => value.map(real)
};

export const Str	= {from: (v?: EngineValue) => typeof v === 'string' ? v : undefined, to: (value: string): EngineValue => value};
/** A dictionary as it is (an empty one if the item is not one, so that what is inside it can be asked for without checking). */
export const Raw	= {from: (v?: EngineValue): EngineDict => isDict(v) ? v : {}, to: (value: EngineDict): EngineValue => value};

/** A dictionary of fields inside a dictionary (one that is not there has none of them). */
export const Dict	= <S extends EngineSpecs>(spec: S): {from: (v?: EngineValue) => SpecOf<S>, to: (value: DeepPartial<SpecOf<S>>) => EngineValue} => ({
	from:	v => readDict(spec, isDict(v) ? v : {}),
	to:		value => writeDict(spec, value),
});
/** A list (an empty one if the item is not one). */
export const Elems	= <T>(a: EngineAccess<T>): EngineAccess<T[]> => ({
	from:	v => Array.isArray(v) ? v.map(x => a.from(x)).filter((x): x is T => x !== undefined) : [],
	to:		value => value.map(x => a.to(x)).filter((x): x is EngineValue => x !== undefined),
});

//-----------------------------------------------------------------------------
//	dictionary read/write
//-----------------------------------------------------------------------------

/** The fields of an engine dictionary. */
export function readDict<S extends EngineSpecs>(spec: S, dict: EngineDict): SpecOf<S> {
	const out = {} as any;
	for (const [k, [name, a]] of Object.entries(spec))
		out[k] = a.from(dict[name]);
	return out;
}
/** The dictionary for an object; a field that is undefined is left out. */
export function writeDict<S extends EngineSpecs>(spec: S, value: DeepPartial<SpecOf<S>>): EngineDict {
	const out: EngineDict = {};
	for (const [k, [name, a]] of Object.entries(spec)) {
		const field = (value as any)[k], written = field === undefined ? undefined : a.to(field);
		if (written !== undefined)
			out[name] = written;
	}
	return out;
}

/** Written entries put over a dictionary: a dictionary in both is merged into, so what the file keeps of it stays; anything else replaces. */
export function mergeDict(into: EngineDict, written: EngineDict): EngineDict {
	for (const [k, v] of Object.entries(written)) {
		const was = into[k];
		if (isDict(was) && isDict(v))
			mergeDict(was, v);
		else
			into[k] = v;
	}
	return into;
}
export function putDict<S extends EngineSpecs>(into: EngineDict, spec: S, value: DeepPartial<SpecOf<S>>): EngineDict {
	return mergeDict(into, writeDict(spec, value));
}
