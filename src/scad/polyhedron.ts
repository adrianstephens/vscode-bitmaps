// A solid as corners and faces: what polyhedron() and import() give meshfield.ts to make a field of, and what mesher.ts
// makes of a field. Each face is anticlockwise seen from outside (a polyhedron()'s clockwise ones are turned round by the
// field that reads them); the files that hold one are read and written by @isopodlabs/binary_meshes.
export type { Mesh as Polyhedron } from '@isopodlabs/binary_meshes';
