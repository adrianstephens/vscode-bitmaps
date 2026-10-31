// Colours that see the surface's normal, images looked up as functions, and displace(): a height map on any shape.
// None of this is OpenSCAD's own; it is this viewer's, and like the functional surfaces it is compiled to the shader.
// bricks.png and bricks_height.png tile both ways: 4 bricks across, 4 courses up.

bricks	= texture("bricks.png");			// img(u, v) is [r, g, b, a], u and v 0..1 across the image, repeating
height	= texture("bricks_height.png");		// 1 on a brick's face, falling to 0 in the mortar

// a colour from the normal: function(x, y, z, nx, ny, nz), the normal in the frame color() is written in
translate([-50, 0, 12])
	color(function(x, y, z, nx, ny, nz) [0.5 + 0.5 * nx, 0.5 + 0.5 * ny, 0.5 + 0.5 * nz])
		sphere(r = 12);

// A brick tower: the colour and the height looked up by the same cylindrical projection -- three repeats of the image
// round (atan2 is in degrees, -180..180) and a course every 4 mm up -- and the bricks stood out along the normal. The
// (1 - abs(nz)) keeps the top flat. It stands on a plain plinth, unioned outside the displace(): where a displaced face
// meets a plain one in a corner, the displacement would be cut off half way between them.
uv = function(x, y, z) [atan2(y, x) / 120, z / 16];
union() {
	color(function(x, y, z) let(c = bricks(uv(x, y, z))) [c[0], c[1], c[2]])
		displace(function(x, y, z, nx, ny, nz) 0.8 * height(uv(x, y, z))[0] * (1 - abs(nz)))
			cylinder(r = 15, h = 40);
	color("dimgray") translate([0, 0, -3]) cylinder(r = 18, h = 3);
}

// A knurled block: a diamond pattern that needs no projection per face, because x + y runs across every side face. On
// the faces it is measured at the point on the block's own surface, which is what h is given by default.
translate([50, 0, 15])
	color("silver")
		displace(function(x, y, z, nx, ny, nz) 0.6 * abs(sin((x + y + z) * 45) * sin((x + y - z) * 45)) * (1 - abs(nz)))
			cube(30, center = true);

// A planet: a procedural height on a sphere, coloured by how high the surface is where the ray hits it -- the colour
// function is asked at the moved surface, so the height is just the distance from the middle.
terrain = function(x, y, z) 0.6 * sin(x * 20 + y * 13) + 0.5 * sin(y * 17 - z * 23 + 30) + 0.4 * sin(z * 19 + x * 11 + 60);
translate([100, 0, 15])
	color(function(x, y, z) let(r = norm([x, y, z]) - 12)
		r < 0.05 ? [0.1, 0.3, 0.7] : r < 0.8 ? [0.3, 0.55, 0.2] : [0.85, 0.85, 0.9])
		displace(function(x, y, z) max(terrain(x, y, z), 0))
			sphere(r = 12);

// base = false asks h where the moved point is, not at the surface under it: cheaper (no normal to find), and the same
// for a projection that does not change along the normal, as the tower's does not. With no normal there is nothing to
// keep the top flat, so it takes the bricks' pattern too.
translate([150, 0, 0])
	displace(function(x, y, z) 0.8 * height(uv(x, y, z))[0], base = false)
		cylinder(r = 10, h = 30);
