import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import type { BlockId, CompileResult, EventName, JudgeReport, LaunchId, LaunchKind, RecordKind, RunId, RunStatus, Status } from "./model";

export type Request =
	| { readonly op: "hello"; readonly args: { readonly session: string; readonly pane?: string } }
	| { readonly op: "lock"; readonly args: { readonly run?: RunId; readonly block: BlockId } }
	| { readonly op: "unlock"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly request: string } }
	| { readonly op: "read"; readonly args: { readonly run?: RunId; readonly block?: BlockId } }
	| {
			readonly op: "set";
			readonly args:
				| { readonly run?: RunId; readonly block: BlockId; readonly field: "title"; readonly value: string }
				| { readonly run?: RunId; readonly block: BlockId; readonly field: "status"; readonly value: Status }
				| { readonly run?: RunId; readonly block: BlockId; readonly field: "task"; readonly value: boolean }
				| { readonly run?: RunId; readonly block: BlockId; readonly field: "agent"; readonly value: string | null }
				| { readonly run?: RunId; readonly block: BlockId; readonly field: "isolated"; readonly value: boolean | null };
	  }
	| {
			readonly op: "edit";
			readonly args: { readonly run?: RunId; readonly block: BlockId; readonly find: string; readonly replace: string };
	  }
	| { readonly op: "write"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly text: string } }
	| {
			readonly op: "panel";
			readonly args: { readonly run?: RunId; readonly block: BlockId; readonly panel: string; readonly text: string };
	  }
	| {
			readonly op: "insert";
			readonly args: { readonly run?: RunId; readonly after?: BlockId; readonly title: string; readonly content: InsertContent };
	  }
	| { readonly op: "move"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly after: BlockId | null } }
	| { readonly op: "revisions"; readonly args: { readonly run?: RunId; readonly block?: BlockId; readonly after?: number } }
	| { readonly op: "delete"; readonly args: { readonly run?: RunId; readonly block: BlockId } }
	| { readonly op: "refetch"; readonly args: { readonly run?: RunId; readonly targets: readonly string[] } }
	| { readonly op: "compile"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| { readonly op: "inspect"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| {
			readonly op: "report";
			readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[]; readonly version: string; readonly result: JudgeReport };
	  }
	| { readonly op: "launch"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| { readonly op: "bind"; readonly args: { readonly launch: LaunchId; readonly agent: string } }
	| { readonly op: "rebase"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "close"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "launch_info"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "start_run"; readonly args: { readonly name: string; readonly update_every?: number } }
	| { readonly op: "finish_run"; readonly args: { readonly run: RunId } }
	| { readonly op: "runs"; readonly args: Record<string, never> }
	| { readonly op: "timeline"; readonly args: { readonly run?: RunId; readonly after?: number; readonly limit?: number } }
	| {
			readonly op: "post";
			readonly args: {
				readonly run?: RunId;
				readonly kind: RecordKind;
				readonly text: string;
				readonly block?: BlockId;
				readonly launch?: LaunchId;
				readonly next?: number;
				readonly quote?: string;
				readonly origin?: "human";
			};
	  }
	| { readonly op: "snooze"; readonly args: { readonly run: RunId; readonly after: number } }
	| { readonly op: "ack"; readonly args: { readonly event: string } }
	| { readonly op: "agents"; readonly args: { readonly result: AgentAnswer } }
	| { readonly op: "reveal"; readonly args: Record<string, never> };

export type Op = Request["op"];
export type ArgsOf<O extends Op> = Extract<Request, { op: O }>["args"];

export type ErrorCode =
	| "Busy"
	| "NotHello"
	| "Locked"
	| "NotLocked"
	| "UnknownBlock"
	| "UnknownRun"
	| "RunFinished"
	| "BadValue"
	| "NotFound"
	| "Ambiguous"
	| "BadLaunch"
	| "CompileError"
	| "UnknownTarget"
	| "BadReport"
	| "UnknownLaunch"
	| "NotOwner"
	| "UnknownEvent"
	| "RevealFailed";

export interface ProtocolError {
	readonly code: ErrorCode;
	readonly message: string;
	readonly detail?: unknown;
}

export type Outcome<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: ProtocolError };

export function ok<T>(result: T): Outcome<T> {
	return { ok: true, result };
}
export function fail(code: ErrorCode, message: string, detail?: unknown): Outcome<never> {
	return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}

export interface RunSummary {
	readonly id: RunId;
	readonly name: string;
	readonly status: RunStatus;
	readonly started_at: number;
	readonly finished_at: number | null;
	readonly done: number;
	readonly total: number;
	readonly update_due: number | null;
	readonly update_overdue: boolean;
	readonly retrospective: boolean;
}

export type EventPayload =
	| {
			readonly event: "block_changed";
			readonly data: {
				readonly id: string;
				readonly launch: { readonly id: LaunchId; readonly kind: LaunchKind; readonly run?: RunId };
				readonly agents: readonly string[];
				readonly changed: readonly BlockId[];
				readonly diff: string;
				readonly current: CompileResult;
			};
	  }
	| { readonly event: "launch_requested"; readonly data: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| {
			readonly event: "stop_requested";
			readonly data: {
				readonly run?: RunId;
				readonly block: BlockId;
				readonly launches: readonly { readonly id: LaunchId; readonly agents: readonly string[] }[];
			};
	  }
	| { readonly event: "status_changed"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly status: Status } }
	| { readonly event: "update_due"; readonly data: { readonly run: RunId; readonly due: number; readonly last_update: number | null } }
	| { readonly event: "interrupted"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly request: string } }
	| { readonly event: "revision_requested"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly revision: number } }
	| { readonly event: "agents_requested"; readonly data: Record<string, never> };

export type AgentAnswer =
	| { readonly kind: "listed"; readonly names: readonly string[] }
	| { readonly kind: "unavailable"; readonly reason: string };

export type InsertContent =
	| { readonly kind: "task"; readonly body: string; readonly agent?: string; readonly isolated?: boolean }
	| { readonly kind: "design"; readonly design: string };

type _EventsCovered = [EventName] extends [EventPayload["event"]] ? ([EventPayload["event"]] extends [EventName] ? true : never) : never;
const _eventsCovered: _EventsCovered = true;
void _eventsCovered;

export type ClientFrame = { readonly id: string; readonly op: string; readonly args: unknown };
export type ServerFrame =
	| { readonly id: string; readonly ok: true; readonly result: unknown }
	| { readonly id: string; readonly ok: false; readonly error: ProtocolError }
	| EventPayload;

/**
 * The host treats the directory string as the endpoint's identity, so every process must derive
 * the same characters (on macOS `/var` and `/tmp` are symbolic links into `/private`).
 */
function endpointDirectory(): string {
	const directory = `${tmpdir().replace(/\/$/, "")}/omp-playbooks`;
	mkdirSync(directory, { recursive: true });
	return realpathSync.native(directory);
}

export function documentEndpoint(playbookAbsPath: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(playbookAbsPath).digest("hex");
	return ipcEndpoint(endpointDirectory(), hash);
}

export type PaneRequest = { readonly op: "ping" } | { readonly op: "attach"; readonly doc: string };

export type PaneReply =
	| { readonly ok: true; readonly session: string; readonly cwd: string }
	| { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function paneEndpoint(pane: string): string {
	return ipcEndpoint(endpointDirectory(), `pane-${pane}`);
}
