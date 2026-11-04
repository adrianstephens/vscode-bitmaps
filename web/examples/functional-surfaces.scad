// Functional surfaces: the function is compiled to the shader and evaluated per pixel, not sampled into a grid.
// Trigonometry is in degrees, as in the rest of OpenSCAD.

// a height field: z = f(x, y) over a rectangle, solid down to `bottom`
surface_fn(function(x, y) 4 * sin(x * 20) * cos(y * 20) * exp(-(x*x + y*y) / 200),
	x = [-15, 15], y = [-15, 15], bottom = -3);

// an implicit surface: solid where the function is negative, inside the box given
translate([40, 0, 0]) color([1,1,1,0])
implicit_fn(function(x, y, z) sin(x*40)*cos(y*40) + sin(y*40)*cos(z*40) + sin(z*40)*cos(x*40) - 0.2,
	x = [-12, 12], y = [-12, 12], z = [-12, 12]);

// it composes: a function stored in a variable, cut and moved like any other solid
ripple = function(x, y) 1.5 * sin(sqrt(x*x + y*y) * 40);
translate([-40, 0, 0]) difference() {
	surface_fn(ripple, x = [-12, 12], y = [-12, 12], bottom = -4);
	cylinder(r = 4, h = 100, center = true);
}
