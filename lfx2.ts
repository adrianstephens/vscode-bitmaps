// Shape of the lfx2 (object-based effects) block, reduced from lfx2.json.
// Descriptor keys are the raw 4-char Photoshop keys; trailing comments give the sample value seen.
// Descriptor wrappers ({type, value, unit}) are dropped: each field shows its unwrapped type.

type Percent = number;	// UntF #Prc
type Angle   = number;	// UntF #Ang (degrees)
type Pixels  = number;	// UntF #Pxl

type BlendMode = string;	// enum BlnM: 'Nrml' | 'Mltp' | 'Scrn' ...

interface RGBC {		// classId RGBC, 0..255
	Rd: number;
	Grn: number;
	Bl: number;
}

interface Pnt {			// classId 'Pnt '
	Hrzn: number | Percent;	// doub in patternFill.phase, UntF #Prc in GrFl.Ofst
	Vrtc: number | Percent;
}

interface CrPt {		// classId CrPt, curve point 0..255
	Hrzn: number;
	Vrtc: number;
}

interface ShpC {		// classId ShpC, contour
	Nm: string;			// 'Linear'
	Crv: CrPt[];		// [{0,0}, {255,255}]
}

// common to every effect
interface EffectBase {
	enab: boolean;
	present: boolean;
	showInDialog: boolean;
}

// ---- gradient ----

interface Clrt {		// classId Clrt, colour stop
	Clr: RGBC;
	Type: string;		// enum Clry: 'UsrS'
	Lctn: number;		// long, 0..4096
	Mdpn: number;		// long, midpoint %, 50
}

interface TrnS {		// classId TrnS, opacity stop
	Opct: Percent;
	Lctn: number;		// long, 0..4096
	Mdpn: number;		// long, 50
}

interface Grdn {		// classId Grdn (name 'Gradient')
	Nm: string;			// 'Orange_08'
	GrdF: string;		// enum GrdF: 'CstS'
	Intr: number;		// doub, smoothness, 4096
	Clrs: Clrt[];
	Trns: TrnS[];
}

// ---- effects ----

interface DrSh extends EffectBase {		// element of dropShadowMulti; innerShadowMulti is IrSh, same fields minus layerConceals
	Md: BlendMode;		// 'Mltp'
	Clr: RGBC;
	Opct: Percent;		// 35
	uglg: boolean;		// use global light
	lagl: Angle;		// 90
	Dstn: Pixels;		// 13
	Ckmt: Pixels;		// choke/spread, 0
	blur: Pixels;		// 29
	Nose: Percent;		// 0
	AntA: boolean;
	TrnS: ShpC;
	layerConceals?: boolean;	// DrSh only
}

interface OrGl extends EffectBase {		// outer glow
	Md: BlendMode;		// 'Scrn'
	Clr: RGBC;
	Opct: Percent;
	GlwT: string;		// enum BETE: 'SfBL' (softer)
	Ckmt: Pixels;
	blur: Pixels;
	Nose: Percent;
	ShdN: Percent;		// jitter
	AntA: boolean;
	TrnS: ShpC;
	Inpr: Percent;		// range, 50
}

interface IrGl extends OrGl {			// inner glow
	glwS: string;		// enum IGSr: 'SrcE' (edge)
}

interface SoFi extends EffectBase {		// element of solidFillMulti
	Md: BlendMode;
	Clr: RGBC;			// values are non-integer: 129.00192260742188
	Opct: Percent;
}

interface GrFl extends EffectBase {		// gradient overlay
	Md: BlendMode;
	Opct: Percent;
	Grad: Grdn;
	Angl: Angle;		// -142
	Type: string;		// enum GrdT: 'Rdl ' (radial)
	Rvrs: boolean;
	Dthr: boolean;
	Algn: boolean;
	Scl: Percent;
	Ofst: Pnt;			// Percent components
}

interface patternFill extends EffectBase {	// pattern overlay
	Md: BlendMode;
	Opct: Percent;
	Ptrn: {
		Nm: string;		// 'Tree Tile 4'
		Idnt: string;	// uuid
	};
	Scl: Percent;
	Algn: boolean;
	phase: Pnt;			// doub components
}

interface FrFX extends EffectBase {		// stroke
	Styl: string;		// enum FStl: 'OutF' (outside)
	PntT: string;		// enum FrFl: 'SClr' (solid colour)
	Md: BlendMode;
	Opct: Percent;
	Sz: Pixels;			// 57
	Clr: RGBC;
	overprint: boolean;
}

interface ebbl extends EffectBase {		// bevel & emboss
	hglM: BlendMode;	// highlight mode
	hglC: RGBC;
	hglO: Percent;
	sdwM: BlendMode;	// shadow mode
	sdwC: RGBC;
	sdwO: Percent;
	bvlT: string;		// enum bvlT: 'PrBL' (chisel hard/soft/smooth)
	bvlS: string;		// enum BESl: 'InrB' (inner bevel)
	uglg: boolean;
	lagl: Angle;
	Lald: Angle;		// altitude, 30
	srgR: Percent;		// depth, 100
	blur: Pixels;		// size, 8
	bvlD: string;		// enum BESs: 'In  ' (direction)
	TrnS: ShpC;
	antialiasGloss: boolean;
	Sftn: Pixels;		// soften
	useShape: boolean;
	useTexture: boolean;
}

interface ChFX extends EffectBase {		// satin
	Md: BlendMode;
	Clr: RGBC;
	AntA: boolean;
	Invr: boolean;
	Opct: Percent;
	lagl: Angle;
	Dstn: Pixels;		// 208
	blur: Pixels;		// 217
	MpgS: ShpC;			// contour (note: MpgS, not TrnS)
}

// ---- block ----

interface Lfx2 {
	key: 'lfx2';
	effectsVersion: number;	// 0
	version: number;		// 16 (descriptor version)
	descriptor: {
		name: string;		// ''
		classId: 'null';
		items: {
			Scl: Percent;			// 416.67
			masterFXSwitch: boolean;
			dropShadowMulti: DrSh[];
			innerShadowMulti: DrSh[];	// classId IrSh
			OrGl: OrGl;
			solidFillMulti: SoFi[];
			GrFl: GrFl;
			patternFill: patternFill;
			FrFX: FrFX;
			IrGl: IrGl;
			ebbl: ebbl;
			ChFX: ChFX;
			numModifyingFX: number;	// long, 2 (enabled effects: GrFl + FrFX)
		};
	};
	padding: Record<string, number>;	// { "0": 0 }
}
