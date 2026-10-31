// The scad modules as the scad tests use them: evaluate(source, name, files?, values?) taking the source as text (parsed here) and
// giving the shape as its tree (which the tests make an SDF of themselves), as it once did; the rest of evaluate.js as it is; and the
// mesher, which is binary_meshes' now and takes an SDF, here given the tree as well.
const ev = require('../out/src/scad/evaluate.js');
const { parse } = require('../out/src/scad/parser.js');
const { SDF } = require('../out/src/scad/sdf.js');
const { mesher, checkMesh } = require('@isopodlabs/binary_meshes');

// (a third argument that can read files is the files; otherwise it is the values)
function evaluate(source, name = 'test.scad', files, values) {
	if (files && typeof files.read !== 'function') {
		values = files;
		files = undefined;
	}
	const file = typeof source === 'string' ? parse(source, name, files) : source;
	const result = ev.evaluate(file, name, files, values ?? {});
	return {...result, sdf: result.sdf.root};
}

const sdfOf = s => s instanceof SDF ? s : new SDF(s);
module.exports = {
	...ev, ...mesher, checkMesh, evaluate,
	// the uniform mesher is the adaptive one never stopping above the finest cube
	meshUniform: (s, options) => mesher.meshAdaptive(sdfOf(s), {...options, tolerance: 0}),
	meshAdaptive: (s, options) => mesher.meshAdaptive(sdfOf(s), options),
};
