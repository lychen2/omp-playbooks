import { readImageFromClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { ptree } from "@oh-my-pi/pi-utils";
import type { ClipboardImageReader } from "./ui";

async function pasteboardPng(): Promise<Uint8Array | null> {
	const { stdout: text, exitCode } = await ptree.exec(["osascript", "-e", "the clipboard as «class PNGf»"], { allowNonZero: true });
	const hex = exitCode === 0 ? /«data PNGf([0-9A-Fa-f]+)»/.exec(text)?.[1] : undefined;
	return hex ? new Uint8Array(Buffer.from(hex, "hex")) : null;
}

export const readClipboardImage: ClipboardImageReader = async () => {
	let failure: unknown = null;
	try {
		const image = await readImageFromClipboard();
		if (image) return image;
	} catch (error) {
		failure = error;
	}
	if (process.platform === "darwin") {
		const png = await pasteboardPng();
		if (png) return { data: png, mimeType: "image/png" };
	}
	if (failure !== null) throw failure;
	return null;
};
