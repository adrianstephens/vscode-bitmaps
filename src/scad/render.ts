// What a .scad text says the model is: the modules there are to run, and the field with the raymarcher generated for it. What the
// viewer's page is sent of that is for the caller to say. No `vscode` here (the extension's ScadViewer and a web page's host both call it);
// `files` is what `use`, `include`, surface() and import() read through, and runs `run` (which reads through it) until it has what it asked for.
import { parse, type UserModule } from './parser';
import { evaluate, type Camera } from './evaluate';
import * as SDF from './sdf';
import { float3 } from '@isopodlabs/maths/vector';
import type { SyncFiles } from '../filereader';

// the field of a text, with the raymarcher generated for it
export interface Model {
	code:		string;							// the GLSL of map(), with the functions it uses
	data:		Float32Array;
	center:		float3;
	half:		float3;
	info:		string;
	warnings:	string[];
	camera:		Camera;
}

export interface Rendered {
	run?:		string;							// the module asked to run, unless the text no longer has it
	names:		string[];						// the modules there are to run
	drawn:		boolean;						// whether the text draws anything of itself (a text that does not is waiting for a module to be run)
	warnings:	string[];						// what the evaluator had to say, which is all there is to show of a text that draws nothing
	model?:		Model;							// not there when the text draws nothing, or has been changed since (`stale`)
}

// `stale` is asked once the field is generated, for a caller whose text may have changed meanwhile
export async function renderScad(source: string, name: string, files: SyncFiles, run?: string, stale = () => false): Promise<Rendered> {
	const file		= await files.with(() => parse(source, name, files));
	const modules	= [...file.scope.modules.values()];
	const callable	= (m: UserModule) => m.parameters.every(p => p.expr);
	const names		= [...modules.filter(callable), ...modules.filter(m => !callable(m))].map(m => m.name);

	if (run && !names.includes(run))
		run = undefined;

	const {sdf, warnings, box, camera} = await files.with(() => evaluate(file, name, files, {$preview: true, $entry: run}));

	const drawn = !!box;

	if (!box || !Number.isFinite(box.min.x) || !Number.isFinite(box.min.y) || !Number.isFinite(box.min.z))
		return {run, names, drawn, warnings};

	const center	= box.max.add(box.min).scale(0.5);
	const size		= box.max.sub(box.min);
	
	let stripped = false;
	let sdf2 = sdf.walk((sdf, process) => {
		switch (sdf.k) {
			case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2':
				stripped = true;
				return SDF.empty;
			case 'offset': case 'extrude': case 'revolve':
				return sdf;			// these are what a 2-D shape is for
			default:
				return process(sdf);
		}
	});

	if (stripped) {
		warnings.push('a 2-D shape (circle, square or polygon) outside linear_extrude/rotate_extrude, which the viewer draws as a flat sheet and an export leaves out');

		const thickness = Math.max(size.x, size.y, size.z) * 1e-3;
		const sheet = (body: SDF.Sdf): SDF.Sdf => ({k: 'extrude', h: thickness, center: true, body});

		const flat = sdf.walk((s, process) => {
			switch (s.k) {
				case 'circle2': case 'square2': case 'polygon2': case 'curvepath2': case 'stadium2': case 'offset':
					return sheet(s);
				case 'union':
					// one sheet for a union of shapes, as one extrude takes them, so a big union is still one the batch can hold
					return s.children.every(SDF.is2d) ? sheet(s) : process(s);
				case 'intersection':
					return s.children.every(SDF.is2d) ? sheet(s) : SDF.empty;
				case 'difference':
					return SDF.is2d(s.base) ? sheet(s) : SDF.empty;
				case 'domain':
					return SDF.is2d(s.body) ? sheet(s) : SDF.empty;
				case 'material':
					return process(s);
				default:
					return SDF.empty;
			}
		});
		
		sdf2 = SDF.union([sdf2, flat]);
	}

	const palette	= SDF.materials(sdf2);

	const {helpers, body, data} = SDF.emitGlsl(sdf2);
	// map() returns the distance and the material together, so both come out of the one evaluation
	const code		= [...helpers, 'vec2 map(vec3 p) {', ...body, '\treturn d;', '}'].join('\n');
	const count		= SDF.countPrimitives(sdf2);
	const model		= stale() ? undefined : {
		code, data, center,
		half:		size.scale(0.5).add(float3(1e-3, 1e-3, 1e-3)),
		info:		`${count} primitives, ${size._values.map(v => v.toFixed(1)).join(' x ')} mm, ${helpers.length} generated functions${palette.length > 1 ? `, ${palette.length - 1} material${palette.length === 2 ? '' : 's'}` : ''}`,
		warnings,
		camera,
	};

	return {run, names, drawn, warnings, model};
}
