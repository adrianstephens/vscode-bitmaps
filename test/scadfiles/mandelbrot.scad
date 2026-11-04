// A Mandelbrot height field. A function surface has no loops at run time -- the body is unrolled while it is compiled --
// so the iteration is a recursion on a constant count, and the "has it escaped" test becomes a select in the shader.

iterations = 40;

// The smooth iteration count of z -> z^2 + c: the steps taken before |z| passes a large bailout, less log2(log|z|) at that
// point, which removes the bands the whole-number count leaves. A point that never escapes gets the full count.
// The bailout is large (|z|^2 > 256) because the correction is more exact the further out z is.
function steps(zr, zi, cr, ci, n) =
	n == 0 ? 0 :
	zr*zr + zi*zi > 256 ? 1 - ln(ln(zr*zr + zi*zi) / 2) / ln(2) :
	1 + steps(zr*zr - zi*zi + cr, 2*zr*zi + ci, cr, ci, n - 1);

// colour is a function of the point too, in the frame color() is written in -- inside the scale(), so x and y are the plane's
scale([100,100,100]) /*color(function(x, y, z) let(t = steps(0, 0, x, y, iterations) / iterations)
		t > 0.999 ? [0, 0, 0] : [0.5 + 0.5 * cos(360 * (3 * t + 0.0)), 0.5 + 0.5 * cos(360 * (3 * t + 0.33)), 0.5 + 0.5 * cos(360 * (3 * t + 0.67))])*/
	surface_fn(function(x, y) ln(ln(steps(0, 0, x, y, iterations)))+0.2,
	x = [-2.2, 0.8], y = [-1.5, 1.5], bottom = 0);
