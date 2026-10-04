// A twelve-sided letter die: a regular dodecahedron, sphere-clipped so each pentagon face becomes a flat circle
// (the sphere's own radius is picked so that circle reaches exactly to the pentagon's edge midpoints -- see the
// sphere/dodecahedron discussion this came out of), with one letter engraved into each face.
//
// letterSets holds 7 dice's worth of letters for a Spelling-Bee-style word game (words need only contain
// whichever die is playing the centre role -- unlike Boggle, adjacency on the die doesn't matter) -- picked for a
// reasonable vowel/consonant mix on every die, Scrabble-ish in frequency, "Qu" standing in for Q the way Boggle's
// own cubes do. Change `set` below to carve a different one.
letterSets = [
	["A", "E", "I", "K", "O", "C", "D", "H", "N", "P", "S", "T"],
	["A", "E", "I", "H", "M", "N", "R", "S", "T", "D", "V", "Y"],
	["E", "F", "H", "M", "N", "O", "R", "S", "U", "D", "Y", "B"],
	["A", "B", "E", "F", "I", "J", "L", "M", "O", "R", "S", "U"],
	["A", "B", "E", "G", "I", "L", "O", "R", "S", "T", "U", "Z"],
	["A", "C", "E", "G", "L", "N", "O", "Qu", "R", "T", "U", "W"],
	["A", "C", "D", "E", "G", "I", "L", "N", "O", "P", "T", "W"],
];
set = -3;

edge = 20;						// edge length
inradius = edge / 2 * sqrt(5 / 2 + 11 / (2 * sqrt(5)));	// centre to a face
apothem  = edge / (2 * tan(180 / 5));						// centre to that face's own edge midpoint
tilt = atan(2);					// 63.435 degrees between adjacent face normals
die_r = sqrt(inradius * inradius + apothem * apothem);	// the die's own radius -- reaches to each face's edge midpoints

module slab(x, y, z)
	cube([x, y, z], center = true);

module dodecahedron() {
	x = 4 * edge;
	z = 2 * inradius;
	// a plain `for` here would union its five iterations before intersecting -- barely constraining anything, since
	// intersecting with the *union* of the five tilted slabs excludes almost nothing a single one didn't already.
	// intersection_for() is the dedicated construct for intersecting each iteration in turn (see childrenOf's own
	// comment in evaluate.ts for why plain `for` cannot do this).
	intersection() {
		slab(x, x, z);
		intersection_for (i = [0 : 4])
			rotate([tilt, 0, i * 72])   slab(x, x, z);
	}
}

// the die itself: a sphere clipped by the dodecahedron, so every face is exactly the pentagon's own inscribed circle
module die()
	intersection() {
		sphere(r = die_r);
		dodecahedron();
	}

// one letter, cut down through its face's own plane -- starting inside the die and ending outside it, so the
// difference is a clean engraving regardless of the sphere's curvature there
module letter(ch)
	translate([0, 0, inradius - 1])
		linear_extrude(height = 3)
			text(ch, size = apothem, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");

// one labelled die: the twelve faces, in the same order dodecahedron() builds them -- the "north" and "south"
// poles (the one untilted slab, and its opposite), then five around each pole, tilted and spun 72 degrees apart
module labelled_die(letters) {
	difference() {
		die();
		union() {
			letter(letters[0]);
			for (i = [0 : 4])
				rotate([tilt, 0, i * 72])   letter(letters[i + 1]);
			rotate([180, 0, 0]) {
				letter(letters[6]);
				for (i = [0 : 4])
					rotate([tilt, 0, i * 72])   letter(letters[i + 7]);
			}
		}
	}
}

// --- tray + lid: seven cylindrical cells (one per die, plain flat floors, walls between and around them, the
// same shape the real Boggle tray in the reference photo uses) laid out with a centre cell and six around it, to
// match the Spelling-Bee-style "must use the centre letter" rule -- with a lid that seals over the top and gives
// a die room to tumble while the whole thing is shaken, since the cell walls alone are shorter than a die and are
// only there to keep settled dice apart, not to contain a shake by themselves.
tray_clearance = 4;			// radial room around a die in its own cell
tray_wall      = 2;			// material between neighbouring cells, and around the outside
cell_r         = die_r + tray_clearance;
tray_spacing   = 2 * cell_r + tray_wall;
tray_floor     = 3;
tray_wall_h    = 15;			// the tray's own walls: shorter than a die, just enough to separate settled dice
tray_h         = tray_floor + tray_wall_h;

// one centre die, six in a ring around it
tray_centres = [[0, 0], for (a = [0 : 60 : 300]) [tray_spacing * cos(a), tray_spacing * sin(a)]];

module tray_footprint(r)
	for (c = tray_centres)
		translate(c) circle(r = r);

module tray_area(r, off)
	offset(r = off) hull() tray_footprint(r);

module tray() {
	difference() {
		linear_extrude(tray_h) tray_area(cell_r, tray_wall);
		translate([0, 0, tray_floor])
			linear_extrude(tray_wall_h + 1)
				tray_footprint(cell_r);	// each die's own circle, not hulled together: a wall runs between every pair too
	}
}

module lid() {
//	color([0,1,0]) tray();
	fit     = 0.4;								// total clearance so the lid slips over the tray's wall rather than jamming
	cavity  = 2 * die_r + 30;	// together with the tray's own wall height, enough for a die to tumble

	//minkowski() {
	//	linear_extrude(1) tray_area(cell_r, tray_wall + fit + 1 - 20);
	//	sphere(r = 20);
	//}

	color([1,0,0,1])
	translate([0,0,14])
	rotate([0,0,0]) {
	difference() {
		minkowski() {linear_extrude(cavity) tray_area(cell_r, tray_wall + 2 - 20); sphere(r = 20);}
		translate([0, 0, -50]) cube([200,200,100], center=true);
		translate([0, 0, -2])
			minkowski() {linear_extrude(cavity) tray_area(cell_r, tray_wall - 20 - 1.5); sphere(r = 20);}
		translate([0, 0, 10-cavity])
			linear_extrude(cavity) tray_area(cell_r, tray_wall +.5);
		translate([0, 0, cavity + 20 - 1])
			linear_extrude(1)
				text("Beegle", size = 40, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");
	}
	}

}

if (set >= 0) {
	labelled_die(letterSets[set]);

} else if (set == -1) {
	spacing = 2 * die_r * 1.15;	// a die's own diameter, plus a gap
	for (i = [0 : len(letterSets) - 1])
		translate([(i - (len(letterSets) - 1) / 2) * spacing, 0, 0])
			labelled_die(letterSets[i]);

} else if (set == -2) {			// the tray, with a die (unlabelled) resting in each cell
	tray();
	//for (c = tray_centres)
	//	translate([c[0], c[1], tray_floor + die_r])
	//		die();

} else if (set == -3) {			// the lid on its own
	lid();

} else if (set == -4) {			// tray and lid stacked, as they sit when closed
	tray();
	translate([0, 0, tray_h])
		lid();
}
