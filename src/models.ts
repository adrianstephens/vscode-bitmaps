// The neural network weights the editor's AI tools run, which are too large to ship in the extension: fetched the first
// time one is needed (after asking), checked against a hash, and kept in the extension's global storage.
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export const models: Record<string, {url: string, sha256: string}> = {
	'sam-encoder':	{url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx',	sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749'},
	'lama':			{url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',				sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'},
	'esrgan':		{url: 'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx',	sha256: '1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112'},
	'sam-decoder':	{url: 'https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx',	sha256: '93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d'},
	'style-mosaic':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/mosaic-9.onnx',	sha256: 'fa646dedade881243f8d5a2ceb7de2b93675b21fc24f7482894ac4851a9a0a47'},
	'style-candy':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/candy-9.onnx',	sha256: '9d11a3529d1e547da6ae07201d93484dbab2ec0a3614535752c8f40f0fe2968a'},
	'style-rain-princess':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/rain-princess-9.onnx',	sha256: '4162912e6f75fedef6f810ae989b9e10d3d5d43308dab34b027c850cf255e152'},
	'style-udnie':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/udnie-9.onnx',	sha256: '8656b6ce7dec8f22ee13c2d557d6b67bd6f550dde88d0f2e7c9972aeb765cc0d'},
	'style-pointilism':	{url: 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/pointilism-9.onnx',	sha256: '5ee2b8d4d6bc60a777f54e0fe96a1b717360a004b79d56c67390d4a975b14d98'},
	// AdaIN, a style from any picture (github.com/naoto0804/pytorch-AdaIN, MIT): VGG-19 as its encoder, and its decoder, as PyTorch checkpoints
	'adain-vgg':	{url: 'https://github.com/naoto0804/pytorch-AdaIN/releases/download/v0.0.0/vgg_normalised.pth',	sha256: '804ca2835ecf7539f0cd2a7ac3c18ce81e6f8468969ae7117ac0c148d286bb4a'},
	'adain-decoder':	{url: 'https://github.com/naoto0804/pytorch-AdaIN/releases/download/v0.0.0/decoder.pth',	sha256: '379ca41d59f3a37eed3599bbbc2560c19da5c458870a5ffd3a9dd41aa88f9472'},
};
export type ModelName = keyof typeof models;

let storage: vscode.Uri;
export function setModelStorage(uri: vscode.Uri) {
	storage = uri;
}

const sha256 = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

export async function modelBytes(name: ModelName) {
	const {url, sha256: hash} = models[name];
	const file = vscode.Uri.joinPath(storage, 'models', url.slice(url.lastIndexOf('/') + 1));

	try {
		const data = await vscode.workspace.fs.readFile(file);
		if (sha256(data) === hash)
			return data;
	} catch {
		// not fetched yet
	}

	const host = new URL(url).host;
	if (await vscode.window.showInformationMessage(`This tool runs a neural network that is downloaded once from ${host} and kept on this machine.`, {modal: true}, 'Download') !== 'Download')
		throw new Error('The model was not downloaded.');

	return vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`}, async progress => {
		const response = await fetch(url);
		if (!response.ok || !response.body)
			throw new Error(`Downloading ${url} failed: ${response.status} ${response.statusText}`);

		// read as it comes, so that how much has come can be shown (as a share of all of it, where the server says how much that is)
		const total = Number(response.headers.get('content-length')) || 0, parts: Uint8Array[] = [], reader = response.body.getReader();
		const mb = (n: number) => (n / 2 ** 20).toFixed(1);
		let got = 0;
		for (;;) {
			const {done, value} = await reader.read();
			if (done)
				break;
			parts.push(value);
			got += value.length;
			progress.report(total ? {increment: value.length / total * 100, message: `${mb(got)} of ${mb(total)} MB`} : {message: `${mb(got)} MB`});
		}
		const data = new Uint8Array(got);
		parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
		if (sha256(data) !== hash)
			throw new Error(`${url} is not the file this extension expects.`);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, 'models'));
		await vscode.workspace.fs.writeFile(file, data);
		return data;
	});
}
