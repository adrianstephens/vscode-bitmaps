// A spiral staircase: a wedge for each step, turned and raised a little more than the one before.
steps  = 24;	// [8:48]
rise   = 3;		// [1:6]
turn   = 15;	// [5:30]
radius = 30;	// [15:50]
$fn = 32;

cylinder(r = 4, h = steps * rise + 3);

for (i = [0 : steps - 1])
	translate([0, 0, i * rise])
		rotate([0, 0, i * turn])
			linear_extrude(1.5) polygon([[0, 0], [radius, -7], [radius, 7]]);
