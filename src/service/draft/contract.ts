import type { Target } from "../../domain/model";
import type { TspNode } from "../tsp-types";
import type { SlotDecl } from "./slot";

export interface DraftDiagnostic {
	readonly line: number;
	readonly severity: "error" | "warning";
	readonly component: string;
	readonly message: string;
}

export interface Span {
	readonly start: number;
	readonly end: number;
}

export interface SourceLine {
	readonly text: string;
	readonly offset: number;
}

export interface FenceInput {
	readonly args: string;
	readonly lines: readonly string[];
	readonly line: number;
	readonly starts: readonly number[];
	readonly body: Span;
}

export type Parsed<T> =
	| { readonly ok: true; readonly value: T; readonly diagnostics: readonly DraftDiagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly DraftDiagnostic[] };

export type Change = "same" | "added" | "removed" | "changed";

export type ChangeView = "changes" | "before" | "after";

export type FileRead =
	| { readonly ok: true; readonly bytes: Uint8Array /** Absolute path that was read. */; readonly path: string }
	| { readonly ok: false; readonly error: string };

export interface Rendered {
	readonly nodes: readonly TspNode[];
	readonly diagnostics: readonly DraftDiagnostic[];
}

export interface ListItem {
	readonly span: Span;
	readonly node: TspNode;
}

export interface ChainNode {
	readonly name: string;
	readonly label: string;
	readonly shape: "rect" | "round" | "diamond" | "cylinder";
	readonly slot: string | null;
}

export interface FlowChain {
	readonly nodes: readonly ChainNode[];
	readonly edges: readonly { readonly dashed: boolean; readonly label: string }[];
	rename(index: number, name: string): string | null;
	insertAfter(index: number): string;
	remove(index: number): string | null;
}

export interface EditHost {
	text(id: string, span: Span, multiline: boolean, view: TspNode): TspNode;
	slot(id: string, name: string): TspNode;
	list(id: string, span: Span, ordered: boolean, start: number, items: readonly ListItem[]): TspNode;
	chain(id: string, body: Span, chain: FlowChain): TspNode;
	reference(id: string, text: string, target: Target, alias: string | null): TspNode;
}

/**
 * Renderers are pure apart from these calls: no Core, socket or UI state.
 * Every node id a renderer creates must be unique and start with `${ctx.id}.`.
 */
export interface RenderContext {
	readonly id: string;
	readonly view: ChangeView;
	svg(id: string, svg: string, size: { readonly w: number; readonly h: number }, alt: string): TspNode;
	image(id: string, bytes: Uint8Array, mime: string, alt: string): TspNode;
	readFile(path: string): FileRead;
	readonly slots: ReadonlyMap<string, SlotDecl>;
	readonly edit: EditHost;
}

export function takeMarker(text: string): { readonly change: Change; readonly text: string } {
	const match = /^([+\-~]) (.*)$/s.exec(text);
	if (!match) return { change: "same", text };
	return { change: match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "changed", text: match[2]! };
}

export function diagnostic(
	component: string,
	line: number,
	message: string,
	severity: DraftDiagnostic["severity"] = "error",
): DraftDiagnostic {
	return { line, severity, component, message };
}
