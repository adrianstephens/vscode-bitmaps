import { float2 } from '@isopodlabs/maths/vector';
import { Selection } from '../webview/bitmapSelection';
import { gaussian } from './reference';

const size = float2(40, 40);
const box = (l: number, t: number, r: number, b: number) => new Selection(new float2.extent(float2(l, t), float2(r, b)));
const sq = box(10, 10, 20, 20);
const show = (n: string, s?: Selection) => console.log(n, s ? `${s.min.x},${s.min.y}-${s.max.x},${s.max.y}` : 'none', s?.at(15, 15), s?.at(s.min.x, s.min.y));
show('grow 3', sq.grow(3, size));
show('shrink 3', sq.grow(-3, size));
show('shrink 5', sq.grow(-5, size));
show('border 4', sq.border(4, size));
show('feather 4', sq.feather(4, size, gaussian));
show('smooth 3', sq.smooth(3, size, gaussian));
show('edge shrink', box(0, 0, 10, 10).grow(-2, size));
