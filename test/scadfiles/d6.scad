// --- PRECISION 6-SIDED DIE SPECIFICATIONS ---
die_size = 16.0;       // Total outer width/height/depth in mm
corner_radius = 2.0;  // Radius of the smoothed edges/corners
pip_depth = 0.8;      // Depth of the pip indentations
pip_radius = 1.3;     // Radius of each pip sphere
$fn = 60;             // Smoothness factor for curved surfaces

// Symmetrical coordinate offsets for pip placement (scaled by die size)
c_offset = die_size / 2;
p_pos = die_size * 0.28; 

module precision_die() {
    difference() {
        // Base rounded cube via Constructive Solid Geometry (CSG) intersection
        intersection() {
            cube([die_size, die_size, die_size], center = true);
            
            // Minkowski-like smoothing via sphere-cube hull
            minkowski() {
                cube([die_size - 2*corner_radius, die_size - 2*corner_radius, die_size - 2*corner_radius], center = true);
                sphere(r = corner_radius);
            }
        }
        
        // --- SUBTRACT PIPS (Opposite sides sum to 7) ---
        
        // 1-Pip (Top Face: Z+)
        translate([0, 0, c_offset - pip_depth + pip_radius]) sphere(r = pip_radius);
        
        // 6-Pip (Bottom Face: Z-)
        translate([ p_pos,  p_pos, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        translate([ p_pos,      0, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        translate([ p_pos, -p_pos, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        translate([-p_pos,  p_pos, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        translate([-p_pos,      0, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        translate([-p_pos, -p_pos, -(c_offset - pip_depth + pip_radius)]) sphere(r = pip_radius);
        
        // 2-Pip (Front Face: Y-)
        translate([ p_pos, -(c_offset - pip_depth + pip_radius),  p_pos]) sphere(r = pip_radius);
        translate([-p_pos, -(c_offset - pip_depth + pip_radius), -p_pos]) sphere(r = pip_radius);
        
        // 5-Pip (Back Face: Y+)
        translate([ 0,      c_offset - pip_depth + pip_radius,  0]) sphere(r = pip_radius);
        translate([ p_pos,  c_offset - pip_depth + pip_radius,  p_pos]) sphere(r = pip_radius);
        translate([ p_pos,  c_offset - pip_depth + pip_radius, -p_pos]) sphere(r = pip_radius);
        translate([-p_pos,  c_offset - pip_depth + pip_radius,  p_pos]) sphere(r = pip_radius);
        translate([-p_pos,  c_offset - pip_depth + pip_radius, -p_pos]) sphere(r = pip_radius);
        
        // 3-Pip (Right Face: X+)
        translate([c_offset - pip_depth + pip_radius,  p_pos,  p_pos]) sphere(r = pip_radius);
        translate([c_offset - pip_depth + pip_radius,      0,      0]) sphere(r = pip_radius);
        translate([c_offset - pip_depth + pip_radius, -p_pos, -p_pos]) sphere(r = pip_radius);
        
        // 4-Pip (Left Face: X-)
        translate([-(c_offset - pip_depth + pip_radius),  p_pos,  p_pos]) sphere(r = pip_radius);
        translate([-(c_offset - pip_depth + pip_radius),  p_pos, -p_pos]) sphere(r = pip_radius);
        translate([-(c_offset - pip_depth + pip_radius), -p_pos,  p_pos]) sphere(r = pip_radius);
        translate([-(c_offset - pip_depth + pip_radius), -p_pos, -p_pos]) sphere(r = pip_radius);
    }
}

precision_die();
