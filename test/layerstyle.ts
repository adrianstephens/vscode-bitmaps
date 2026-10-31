import * as fs from 'fs';
import { layerStyle } from '../webview/psdblocks';

// the layer style read from an lfx2 block dumped as json (argv[2])
const block = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(layerStyle({lfx2: block}), null, 1));
