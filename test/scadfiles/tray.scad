// --- PRECISION 7-DICE HEXAGONAL TRAY SPECIFICATIONS ---
die_size = 16.0;         // Size of the die from the previous model (mm)
tolerance = 0.8;        // Extra padding per slot for easy insertion/removal (mm)
wall_thickness = 3.0;   // Outer border and floor thickness (mm)
divider_width = 2.0;    // Structural mesh dividing individual slots (mm)
tray_depth = 12.0;      // Total depth of the cutout slots (mm)
$fn = 60;               // Resolution for rounded corners

// Derived spacing calculations based on hexagonal packing geometry
slot_w = die_size + tolerance;
row_spacing = slot_w + divider_width;
col_spacing = row_spacing * cos(30); // ~0.866025 structural layout offset

module single_die_slot() {
    // Sharp or slightly rounded square cutout pocket
    cube([slot_w, slot_w, tray_depth * 2], center = true);
}

module hexagonal_slot_layout() {
    // Center slot (Position 0,0)
    single_die_slot();
    
    // 6 Surrounding slots forming a perfect hexagon ring
    for (i = [0 : 5]) {
        angle = i * 60;
        translate([row_spacing * cos(angle), row_spacing * sin(angle), 0])
            single_die_slot();
    }
}

module precision_dice_tray() {
    // Calculate total boundary to dynamically size the outer perimeter
    outer_radius = row_spacing + (slot_w / 2) + wall_thickness;
    total_height = tray_depth + wall_thickness;
    
    difference() {
        // Base tray body - Hexagonal block matching the layout orientation
        rotate([0, 0, 30])
            cylinder(h = total_height, r = outer_radius / cos(30), $fn = 6);
        
        // Subtract the 7 slots shifted upwards to leave a solid floor layer
        translate([0, 0, wall_thickness + tray_depth])
            hexagonal_slot_layout();
    }
}

precision_dice_tray();
