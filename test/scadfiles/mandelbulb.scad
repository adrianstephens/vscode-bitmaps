// A Mandelbulb: the power-8 analogue of the Mandelbrot set, z -> z^8 + c in spherical coordinates. It is an implicit_fn whose
// field is the usual distance estimate, 0.5 * ln(r) * r / dr, with dr the running derivative of |z|. Like surface_fn there are no
// loops at run time, so the iteration is a recursion on a constant count that carries the point (x, y, z), the constant
// (cx, cy, cz) and dr down with it. Trigonometry is in degrees, so the angles need no conversion.

iterations = 4;
power = 8;

function bulb(x, y, z, cx, cy, cz, dr, n) =
	let(r = sqrt(x*x + y*y + z*z))
	r < 1e-6 ? -0.1 :					// the origin never leaves it, and its angles are undefined
	n == 0 || r > 2 ?
		0.5 * ln(r) * r / dr :
		let(theta = power * acos(z / r), phi = power * atan2(y, x), rn = pow(r, power))
		bulb(rn * sin(theta) * cos(phi) + cx, rn * sin(theta) * sin(phi) + cy, rn * cos(theta) + cz,
			cx, cy, cz, power * pow(r, power - 1) * dr + 1, n - 1);

// colour by how deep the point is in the iteration: orbit trap on the origin, nearer the core is warmer
scale(10)
	//color(function(x, y, z) let(t = min(1, sqrt(x*x + y*y + z*z) / 1.1)) [0.9 - 0.6 * t, 0.45 + 0.3 * t * t, 0.25 + 0.6 * t])
	implicit_fn(function(x, y, z) bulb(x, y, z, x, y, z, 1, iterations),
		x = [-1.25, 1.25], y = [-1.25, 1.25], z = [-1.25, 1.25], lipschitz = 1);
