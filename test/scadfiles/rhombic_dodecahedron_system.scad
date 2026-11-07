// --- SOLID PRECISION RHOMBIC DODECAHEDRON & HONEYCOMB TRAY ---
mode = "tray"; // Options: "die" or "tray"

die_size = 16.0;       // Flat-to-flat diameter across parallel faces (mm)
die_roundness = 2;
tolerance = 0.4;      // Padding buffer for the tray slots (mm)
wall_thickness = 1.0; // Perimeter wall thickness around the tray (mm)
floor_thickness = 1.0;// Solid material thickness underneath the slots (mm)
shaker_height = 20.0;  // Interior clearance height for the dice to rattle (mm)
lip_clearance = 0.3;   // Mechanical wiggle room so the lid slots on easily (mm)
$fs = 0.1;


die_height = die_size * sqrt(2);

// --- ACCURATE 12-DIAMOND POLYHEDRON MODULE ---
module true_rhombic_dodecahedron(diameter, radius) {
    s = diameter / 2 - radius / sqrt(2);
    s2 = s * 2;

    // 14 Exact vertices in 3D space: 8 cube corners + 6 extended axial points
    v = [
        [-s, -s, -s], [ s, -s, -s], [ s,  s, -s], [-s,  s, -s], // 0-3: Lower cube
        [-s, -s,  s], [ s, -s,  s], [ s,  s,  s], [-s,  s,  s], // 4-7: Upper cube
        [-s2,    0,    0], [ s2,    0,    0],                 // 8,9: X axis tips
        [   0, -s2,    0], [   0,  s2,    0],                 // 10,11: Y axis tips
        [   0,    0, -s2], [   0,    0,  s2]                  // 12,13: Z axis tips
    ];

    // 12 Congruent diamond faces mapped with correct counter-clockwise winding
    f = [
        [6,	9, 	5, 	13 	],   // Face 1 (Z+ to X+)
        [7,	11, 6, 	13 	],  // Face 2 (Z+ to Y+)
        [4,	8, 	7, 	13 	],   // Face 3 (Z+ to X-)
        [5,	10, 4, 	13 	],  // Face 4 (Z+ to Y-)
        [1,	9, 	2, 	12 	],   // Face 5 (Z- to X+)
        [2,	11, 3, 	12 	],  // Face 6 (Z- to Y+)
        [3,	8, 	0, 	12 	],   // Face 7 (Z- to X-)
        [0,	10, 1, 	12 	],  // Face 8 (Z- to Y-)
        [1,	10, 5, 	9 	],   // Face 9 (X+ to Y-)
        [0,	8, 	4, 	10 	],   // Face 10 (Y- to X-)
        [3,	11, 7, 	8 	],   // Face 11 (X- to Y+)
        [2,	9, 	6, 	11 	]    // Face 12 (Y+ to X+)
    ];

    rotate([45,0,0])
    minkowski() {
        polyhedron(points = v, faces = f);
        sphere(r = radius);
    }
}

module symmetrical_honeycomb_layout(die_size, die_roundness, overlap) {
    s = die_size + overlap;
    h = s * sqrt(2);
    true_rhombic_dodecahedron(die_size, die_roundness);
    translate([s, -h/2, h/2])
        true_rhombic_dodecahedron(die_size, die_roundness);
    translate([s, h/2, h/2])
        true_rhombic_dodecahedron(die_size, die_roundness);
    translate([-s, -h/2, h/2])
        true_rhombic_dodecahedron(die_size, die_roundness);
    translate([-s, h/2, h/2])
        true_rhombic_dodecahedron(die_size, die_roundness);
    translate([0,h,h])
        true_rhombic_dodecahedron(die_size, die_roundness);
    translate([0,-h,h])
        true_rhombic_dodecahedron(die_size, die_roundness);
}

module hexagonal_prism(diameter, height, radius) {
    shrunken_diameter = diameter - (radius * 2);

    minkowski() {
        scale([sqrt(2), 1, 1])
            cylinder(h = height, r = diameter / cos(30) / 2, center = true, $fn = 6);
        scale([1,1,0])
            sphere(r = radius);
    }

}

if (mode == "die") {
    color([1,0,0,0], $metallic=1, $specular=1, $ior=1.5)
        true_rhombic_dodecahedron(die_size, die_roundness);
}

if (mode == "dice") {
    color([1,0.7,0.3,1], $metallic=2.5, $specular=2)
        symmetrical_honeycomb_layout(die_size, die_roundness, 0);
}

outer_r = (die_size + tolerance) * 3 + wall_thickness;
total_h = (die_size) + floor_thickness;

if (mode == "tray") {
    // Corrected geometric outer radius to avoid wall clipping
    color([1,0,0,0], $ior=1.5)
    difference() {
        translate([0,0,10])
            hexagonal_prism(outer_r, 20, 4);
        translate([0,0,15])
            symmetrical_honeycomb_layout(die_size + 2, die_roundness, -2);
    }
}

if (mode == "lid") {
    // Inner dimensions of the lid capture the outer dimensions of the tray base
    lid_inner_r = (outer_r / cos(30)) + lip_clearance;
    lid_outer_r = lid_inner_r + wall_thickness;
    
    // We only need the lid lip to overlap the top few millimeters of the tray body to lock in
    overlap_depth = 5.0; 
    lid_total_h = shaker_height + floor_thickness + overlap_depth;

    translate([0, 0, 10])
    difference() {
        // Main outer lid block
        minkowski() {
            cylinder(h = lid_total_h, r = lid_outer_r, center = false, $fn = 6);
            sphere(r = 4);
        }

        translate([0, 0, -25])
        cube([100, 100, 50], center = true);
        
        // 1. Hollow out the primary rattling chamber dome
        translate([0, 0, -1])
            minkowski() {
                cylinder(h = lid_total_h, r = lid_inner_r - wall_thickness, center = false, $fn = 6);
                sphere(r = 4);
            }
            
        // 2. Step out the bottom rim to form the precise slotting lip over the tray
        translate([0, 0, -1])
            minkowski() {
                cylinder(h = overlap_depth + 0.1, r = lid_inner_r, center = false, $fn = 6);
                sphere(r = 4);
            }
    }
}

