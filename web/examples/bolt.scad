// A bolt: a hex head, a shaft, and rings standing for the thread.
diameter = 10;	// [4:20]
length   = 40;	// [10:80]
pitch    = 2;	// [1:4]
$fn = 48;

head = diameter * 1.6;

cylinder(r = head / 2 / cos(30), h = diameter * 0.65, $fn = 6);

translate([0, 0, diameter * 0.65]) {
	cylinder(r = diameter / 2 - 0.8, h = length);
	for (z = [0 : pitch : length - pitch])
		translate([0, 0, z]) rotate_extrude()
			polygon([[diameter / 2 - 0.9, 0], [diameter / 2, pitch * 0.12], [diameter / 2, pitch * 0.6], [diameter / 2 - 0.9, pitch * 0.9]]);
}
