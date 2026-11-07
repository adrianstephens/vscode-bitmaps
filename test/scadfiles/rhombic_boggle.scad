// --- RHOMBIC DODECAHEDRON BOGGLE: 7-POCKET TRAY, RETAINING CAP AND SHAKER LID ---
use <rhombic_dodecahedron_system.scad>

mode = "assembly"; // "die", "tray", "cap", "lid", "assembly" (as fitted), or print_tray / print_cap / print_lid

die_size = 16.0;        // die "diameter" (flat-to-flat is die_size * sqrt(2))
die_roundness = 2;
tolerance = 0.4;        // per-face clearance between die and pocket (mm)
wall = 1.5;             // wall between neighbouring pockets, measured at the equator (mm)
outer_wall = 2.0;       // wall around the whole tray (mm)
floor_t = 1.5;          // floor under the pockets (mm)
rim_above = 4.0;        // pocket wall height above the die equator (mm)
cap_t = 3.0;            // cap plate thickness (mm)
skirt = 5.0;            // how far cap/lid skirts slide down the tray sides (mm)
skirt_w = 1.6;          // skirt wall thickness (mm)
lip_clearance = 0.3;    // gap between tray sides and cap/lid skirt (mm)
chamber_h = 30.0;       // shaker chamber height above the tray rim (mm)
$fs = 0.2;

r = die_roundness;
pd = die_size + sqrt(2) * tolerance;   // pocket die diameter: every face moves out by `tolerance`
ps = pd / 2 - r / sqrt(2);              // half-size of the sharp core before rounding
half_h = pd / sqrt(2);                  // pocket centre to face
zc = floor_t + half_h;                  // pocket centre height (die equator)
H = zc + rim_above;                     // tray height

// Resting on a face, a die's outline is a stretched hexagon 4*ps wide. These tile as a honeycomb.
// Apothems of the outline: A_v for the flat top/bottom edges, A_s for the four slanted edges.
A_v = sqrt(2) * ps + r;
A_s = 2 * sqrt(2) / sqrt(3) * ps + r;
V = 2 * A_v + wall;                                        // vertical pitch between pockets
X = (sqrt(3) * (2 * A_s + wall) - V / 2) / sqrt(2);        // horizontal pitch of the outer four

centres = [[0, 0], [X, V/2], [X, -V/2], [-X, V/2], [-X, -V/2], [0, V], [0, -V]];

// The die's outline when resting on a face: the stretched hexagon of its sharp core, rounded by r.
// The position goes inside the offset (offset of a translated shape, not a translate of an offset).
module die_outline(d, c = [0, 0]) {
    s = d / 2 - r / sqrt(2);
    offset(r = r) translate(c)
        polygon([[2*s, 0], [s, sqrt(2)*s], [-s, sqrt(2)*s], [-2*s, 0], [-s, -sqrt(2)*s], [s, -sqrt(2)*s]]);
}

module pocket(c, d = pd) {
    translate([c[0], c[1], zc]) true_rhombic_dodecahedron(d, r);
    // above the equator the pocket wall goes straight up so dice can drop in
    translate([0, 0, zc - 0.01]) linear_extrude(rim_above + 0.02) die_outline(d, c);
}

module outline() {
    g = wall / 2 + 0.05;
    offset(r = outer_wall) offset(delta = -g) offset(delta = g)
        for (c = centres) die_outline(pd, c);
}

module tray() {
    difference() {
        linear_extrude(H) outline();
        for (c = centres) pocket(c);
    }
}

// Sits on the tray rim. Each hole is the die cross-section at cap height, which narrows above the
// equator, so a settled die cannot lift out. Only the top face shows through.
module cap() {
    difference() {
        union() {
            translate([0, 0, H]) linear_extrude(cap_t)
                offset(delta = lip_clearance + skirt_w) outline();
            translate([0, 0, H - skirt]) linear_extrude(skirt)
                difference() {
                    offset(delta = lip_clearance + skirt_w) outline();
                    offset(delta = lip_clearance) outline();
                }
        }
        for (c = centres) pocket(c);
    }
}

// Closed chamber: dice shake loose inside, then drop into the pockets.
module lid() {
    translate([0, 0, H - skirt])
    difference() {
        linear_extrude(skirt + chamber_h + skirt_w)
            offset(delta = lip_clearance + skirt_w) outline();
        translate([0, 0, -0.01]) linear_extrude(skirt + chamber_h + 0.01)
            offset(delta = lip_clearance) outline();
    }
}

if (mode == "die")
    true_rhombic_dodecahedron(die_size, r);

if (mode == "tray") tray();
if (mode == "cap") cap();
if (mode == "lid") lid();

// Print orientations: tray upright, cap and lid flipped so the flat plate is on the bed.
// Flipped, the cap holes flare upward and the lid roof is flat, so no supports are needed.
if (mode == "print_tray") tray();
if (mode == "print_cap") translate([0, 0, H + cap_t]) mirror([0, 0, 1]) cap();
if (mode == "print_lid") translate([0, 0, H + chamber_h + skirt_w]) mirror([0, 0, 1]) lid();

if (mode == "assembly") {
    color("gray") tray();
    color("orange") for (c = centres)
        translate([c[0], c[1], zc]) true_rhombic_dodecahedron(die_size, r);
    color("steelblue", 0.6) cap();
}
