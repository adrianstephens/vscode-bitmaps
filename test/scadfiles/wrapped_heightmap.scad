// A wrapped heightmap: surface()'s grid bent onto a surface of revolution instead of laid on the plane.
//
// wrapped_heightmap.dat, beside this file, is a 120 x 61 grid at three degrees: a raised line every ten columns
// (thirty degrees of longitude) and every five rows (fifteen of latitude), and one block raised further on the
// equator at longitude zero. That last one is the seam -- the columns are a full turn, so column 0 and column 119
// meet -- and a wrap that did not close would cut that block in half.
//
// wrap("cylinder"/"sphere", r = ...) bends whatever is inside it -- here surface()'s flat grid -- around a surface of
// that radius (d for a diameter). r is the surface it is wrapped *around*: the base, so nothing lands inside it
// whatever the grid's own heights are. A wrapped grid is measured from that base: its floor moves
// onto r and its heights become thicknesses, so this one is a shell from r out to r + 9, one unit thick at its
// thinnest and four under the raised lines. The columns become the turn about z and the rows a height (a cylinder)
// or a latitude (a sphere), so a sphere's first and last rows are its poles -- one point each, where a whole ring of
// columns meets, so each takes its own row's mean height.
//
// A cylinder can be given the length of its axis too: r and h are its two dimensions, as a cylinder primitive has
// them, and `wrap("cylinder", r = 18, h = 45)` is a tube 45 long with the grid's rows spread over it. Without an h
// the axis is the grid's own scaled height -- one unit per row, times any scale in y -- which is 60 units for the
// .dat below and 78 for the tenth-scale photo, so h is what says how long the tube is rather than how long the grid
// is. Over a tiled cylinder h is the length the tile repeats up, as the turn is what a tiled column repeats round.
//
// This is our own extension: OpenSCAD's surface() is flat only, and wrapping one round a sphere is what its issue
// #815 has asked for since 2014 (its #994, wrapping one round a cylinder, was closed as a duplicate of it).
// surface() itself is exactly OpenSCAD's, as the first object below shows; the bending is wrap()'s job.
//
// An image works the same way, its brightness a height of 0 to 100, so the radius has to suit it:
//     wrap("sphere", r = 120) surface("photo.png");
//
// How far round a body goes is its own size: a flat grid is a whole surface already (its columns are a ring), while
// anything scaled across -- or anything that is not a grid, like extruded text -- covers the arc its own width is,
// so scaling it asks for a piece of a sphere or a cylinder rather than all of one.
//
// surface()'s `tiled` is the exception: it makes the grid a tile rather than a surface, so its columns repeat instead
// of ending and the scale sets how much of the surface one copy covers -- one column is that much arc -- rather than
// how much is covered. The turn is always a whole one then, whatever the scale, and the sampling is modulo the grid's
// period, so the tile boundary is the ring closing; a fractional tile count is allowed, though a grid whose columns
// are not periodic shows its own seam where the tile lands. `tiled = true` repeats the rows too: over a sphere's
// meridian they fold at a pole and the longitude turns with them, as it does going over a globe's pole, which is
// smooth only where the fold lands on a pole, and up a cylinder's axis they come round again every tile -- which
// needs an h to be longer than one, since the axis has no length of its own for them to fold over. A tiled grid stays
// on the fused path whatever its scale, which is also what keeps a scaled sphere's poles sane: the general bend has no
// width left to map at a pole and reads as surface across a cap there, where a fused map averages the row that lands
// on it.
//
// All three objects are the same grid: flat, round a cylinder, and round a sphere.

map = "wrapped_heightmap.dat";

// as OpenSCAD's surface() draws it -- 119 by 60 units on the floor, at half scale to sit beside the others
translate([-105, -15, -3]) scale(0.5) surface(map);

// round a cylinder: the columns wrap the circumference, the rows run one unit each up the axis
wrap("cylinder", r = 18) surface(map);

// round a sphere: the columns are longitude and the rows latitude, the meridian lines converging on the poles
translate([85, 0, 0]) wrap("sphere", r = 24) surface(map);
translate([85, 85, 0]) wrap("sphere", r = 24) surface(map);

// Being a wrapper rather than an argument is what lets the grid be scaled first: here a tenth of the relief on the
// same base of 24, so only the shell's thickness changes.
translate([170, 0, 0]) wrap("sphere", r = 24) scale([1, 1, 0.1]) surface(map);

map2 = "/Users/adrianstephens/Pictures/passport.jpg";

translate([-105, 105, -3]) scale([0.1,0.1,0.1]) surface(map2);
// A scaled grid is a piece of a surface rather than a whole one; `tiled` first makes it a tile instead. The
// tenth-scale photo is 78 units wide against a circumference of 151, so as a tile it comes round very nearly twice.
// The first sphere below repeats its rows over the meridian as well as its columns; the second -- the same photo
// left untiled -- stays the piece its own width asks for: a lune from pole to pole across 185 degrees of longitude,
// its ends real cut faces, capped from inside and out. Both are bent as the grid they are, each column carrying its
// own arc, so the relief comes out the same thickness on each.
translate([100, 185, 24]) wrap("sphere", r = 24) scale([0.1,0.1,0.01]) surface(map2, tiled = true);
translate([170, 185, 24]) wrap("sphere", r = 24) scale([0.1,0.1,0.01]) surface(map2);

// The two cylinders are the same photo at the same tenth scale, so one tile is 78 units in either direction: the
// tiled one's scale sets the tile and not the axis, so h is what makes it two tiles long, while the untiled one takes
// its axis from the scale itself -- 78, one copy -- and covers the arc its own width asks for, as the lune above does.
// A piece of a cylinder is bent as the grid it is too, so its relief is as deep as the tiled one's, where the general
// bend would carry the scale of the thinnest of the three axes instead and shade the picture nearly flat.
color([1,0,0], $metallic=1) translate([0, 185, 24]) wrap("cylinder", r = 24, h = 75) scale([0.1,0.1,0.01]) surface(map2, tiled = true);
translate([50, 185, 24]) wrap("cylinder", r = 24) scale([0.1,0.1,0.01]) surface(map2);
