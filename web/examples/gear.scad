// A spur gear: teeth round a hub, with a bore and lightening holes.
teeth     = 18;		// [6:40]
pitch     = 4;		// [2:8]
thickness = 8;		// [2:20]
bore      = 5;		// [0:12]
holes     = 5;		// [0:8]
$fn = 48;

pr = teeth * pitch / (2 * PI);		// the pitch circle's radius

difference() {
	union() {
		cylinder(r = pr - pitch * 0.5, h = thickness);
		for (i = [0 : teeth - 1])
			rotate([0, 0, i * 360 / teeth])
				translate([pr - pitch * 0.2, 0, thickness / 2]) cube([pitch * 1.1, pitch * 0.7, thickness], center = true);
	}
	translate([0, 0, -1]) cylinder(r = bore / 2, h = thickness + 2);
	if (holes > 0)
		for (i = [0 : holes - 1])
			rotate([0, 0, i * 360 / holes]) translate([pr * 0.55, 0, -1]) cylinder(r = pr * 0.14, h = thickness + 2);
}
