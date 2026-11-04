// A box with rounded corners and four screw posts. The numbers below have sliders beside the editor.
width  = 60;	// [30:100]
depth  = 40;	// [20:80]
height = 24;	// [10:50]
radius = 6;		// [1:15]
wall   = 2.5;	// [1:6]
//$fn = 40;

module rounded(w, d, h, r) {
	hull() for (x = [r, w - r], y = [r, d - r])
		translate([x, y, 0]) cylinder(r = r, h = h);
}

difference() {
	rounded(width, depth, height, radius);
	translate([wall, wall, wall]) rounded(width - 2 * wall, depth - 2 * wall, height, max(radius - wall, 0.5));
}

for (x = [radius, width - radius], y = [radius, depth - radius])
	translate([x, y, 0]) difference() {
		cylinder(r = 3.5, h = height - 4);
		translate([0, 0, 2]) cylinder(r = 1.4, h = height);
	}
