export type TspNode = { readonly id: string; readonly k: string; readonly p?: Record<string, unknown>; readonly c?: readonly TspNode[] };

export type FrameOp =
	| readonly ["add", string, string, string | null, TspNode]
	| readonly ["del", string]
	| readonly ["set", string, Record<string, unknown>]
	| readonly ["focus", string | null]
	| readonly ["reveal", string, "start" | "nearest"];

export type TspEvent =
	| { readonly ev: "ack"; readonly s: number }
	| { readonly ev: "error"; readonly s?: number; readonly op?: number; readonly msg?: string }
	| { readonly ev: "theme"; readonly dark: boolean }
	| { readonly ev: "focus"; readonly id: string }
	| { readonly ev: "action"; readonly id: string; readonly act: string; readonly mods: readonly string[] }
	| { readonly ev: "change"; readonly id: string; readonly checked?: boolean; readonly value?: string; readonly text?: string }
	| {
			readonly ev: "edit";
			readonly id: string;
			readonly from: number;
			readonly to: number;
			readonly text: string;
			readonly cursor: number;
			readonly len: number;
	  }
	| { readonly ev: "undo"; readonly id: string }
	| { readonly ev: "toggle"; readonly id: string; readonly collapsed: boolean; readonly key?: string }
	| { readonly ev: "other"; readonly body: unknown };

export type TspInput =
	| { readonly kind: "hello"; readonly dark: boolean }
	| { readonly kind: "event"; readonly event: TspEvent }
	| { readonly kind: "keys"; readonly bytes: string };

export interface FrameStatus {
	readonly blockError: boolean;
	readonly documentError: boolean;
	readonly pendingOverdue: boolean;
}

export interface TspSession {
	start(app: string, onInput: (input: TspInput) => void): void;
	open(surface: string, title: string, css: string): void;
	blob(id: string, mime: string, bytes: Uint8Array): void;
	frame(ops: readonly FrameOp[], blocks: readonly string[]): number;
	status(block: string): FrameStatus;
	fullRedraw(s: number): void;
	onStatusChange(listener: (blocks: readonly string[]) => void): void;
}
