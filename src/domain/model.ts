export type BlockId = `b${number}`;
export type RunId = `r${number}`;
export type LaunchId = `l${number}`;

const BLOCK_ID = /^b([1-9][0-9]*)$/;
const RUN_ID = /^r([1-9][0-9]*)$/;
const LAUNCH_ID = /^l([1-9][0-9]*)$/;

export function parseBlockId(value: string): BlockId | null {
	return BLOCK_ID.test(value) ? (value as BlockId) : null;
}
export function parseRunId(value: string): RunId | null {
	return RUN_ID.test(value) ? (value as RunId) : null;
}
export function parseLaunchId(value: string): LaunchId | null {
	return LAUNCH_ID.test(value) ? (value as LaunchId) : null;
}
export function idNumber(id: BlockId | RunId | LaunchId): number {
	return Number(id.slice(1));
}

export type BlockContent =
	| { readonly kind: "task"; readonly body: string; readonly agent?: string; readonly isolated?: boolean }
	| { readonly kind: "design"; readonly requirement: string; readonly design: string };

export type TaskConfig = Pick<Extract<BlockContent, { kind: "task" }>, "agent" | "isolated">;

export type Status = "todo" | "running" | "done";

export type Progress =
	| { readonly kind: "untracked" }
	| { readonly kind: "tracked"; readonly status: Status; readonly report: string | null };

export interface Block {
	readonly id: BlockId;
	readonly title: string;
	readonly progress: Progress;
	readonly content: BlockContent;
}

export function freshProgress(progress: Progress): Progress {
	return progress.kind === "untracked" ? progress : { kind: "tracked", status: "todo", report: null };
}

export type BlockField = "title" | "body" | "requirement" | "design";
export type HumanField = "title" | "body" | "requirement";

export function fieldText(block: Block, field: BlockField): string | null {
	if (field === "title") return block.title;
	const content = block.content;
	switch (content.kind) {
		case "task":
			return field === "body" ? content.body : null;
		case "design":
			return field === "requirement" ? content.requirement : field === "design" ? content.design : null;
	}
}

export function withField(block: Block, field: BlockField, text: string): Block | null {
	if (field === "title") return { ...block, title: text };
	const content = block.content;
	switch (content.kind) {
		case "task":
			return field === "body" ? { ...block, content: { ...content, body: text } } : null;
		case "design":
			if (field === "requirement") return { ...block, content: { ...content, requirement: text } };
			if (field === "design") return { ...block, content: { ...content, design: text } };
			return null;
	}
}

export function coordinatorField(content: BlockContent): "body" | "design" {
	return content.kind === "task" ? "body" : "design";
}

export function isOrchestration(content: BlockContent): boolean {
	if (content.kind !== "task") return false;
	return /^(`{3,}|~{3,})(js|py)[ \t]*\n[\s\S]*?\n\1[ \t]*\n?$/.test(`${content.body.trim()}\n`);
}

export function outlinedText(content: BlockContent): string | null {
	return isOrchestration(content) ? null : content.kind === "task" ? content.body : content.design;
}

export function humanFieldValid(content: BlockContent, field: HumanField): boolean {
	switch (field) {
		case "title":
			return true;
		case "body":
			return content.kind === "task";
		case "requirement":
			return content.kind === "design";
	}
}

export interface Revision {
	readonly seq: number;
	readonly at: number;
	readonly block: BlockId;
	readonly prompt: string;
}

export interface PlaybookDoc {
	readonly title: string;
	readonly blocks: readonly Block[];
}

export type RunStatus = "running" | "finished";

export interface RunMeta {
	readonly id: RunId;
	readonly name: string;
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly finishedAt: number | null;
	readonly updateEvery: number | null;
	readonly updateDue: number | null;
}

export type DocRef = { readonly kind: "template" } | { readonly kind: "run"; readonly run: RunId };

export type EditOrigin = "human" | "coordinator" | "disk";
export type EntryOrigin = EditOrigin | "service";

export type BlockLock = { readonly kind: "none" } | { readonly kind: "coordinator"; readonly request: string };

export type Target =
	| { readonly kind: "block"; readonly block: BlockId }
	| { readonly kind: "result"; readonly block: BlockId }
	| { readonly kind: "issue"; readonly owner: string; readonly repo: string; readonly number: number; readonly url: string }
	| { readonly kind: "pull"; readonly owner: string; readonly repo: string; readonly number: number; readonly url: string }
	| { readonly kind: "file"; readonly path: string };

export type ExternalTarget = Extract<Target, { kind: "issue" | "pull" | "file" }>;

export type Selector =
	| { readonly kind: "lines"; readonly from: number; readonly to: number }
	| { readonly kind: "section"; readonly heading: string }
	| { readonly kind: "title" }
	| { readonly kind: "body" }
	| { readonly kind: "comments" }
	| { readonly kind: "commentsLast"; readonly count: number }
	| { readonly kind: "commentsRange"; readonly from: number; readonly to: number }
	| { readonly kind: "requirement" }
	| { readonly kind: "design" }
	| { readonly kind: "panel"; readonly id: string };

export interface Reference {
	readonly text: string;
	readonly targetText: string;
	readonly expressionText: string | null;
	readonly offset: number;
}

export interface ReferenceExpression {
	readonly alias: string | null;
	readonly selectors: readonly Selector[];
	readonly selection: string | null;
}

export interface IssueComment {
	readonly author: string;
	readonly createdAt: string;
	readonly body: string;
}
export interface IssueValue {
	readonly title: string;
	readonly body: string;
	readonly comments: readonly IssueComment[];
}

export type FetchOutcome =
	| {
			readonly ok: true;
			readonly at: number;
			readonly value: { readonly kind: "issue"; readonly issue: IssueValue } | { readonly kind: "file"; readonly text: string };
	  }
	| { readonly ok: false; readonly at: number; readonly error: string };

export type TargetKey = string;
export type FetchTable = ReadonlyMap<TargetKey, FetchOutcome>;

export interface BlockResult {
	readonly text: string;
	readonly at: number;
	readonly seq: number;
	readonly origin: EntryOrigin;
	readonly launch: LaunchId | null;
}
export type ResultTable = ReadonlyMap<BlockId, BlockResult>;

export type CompileError =
	| { readonly kind: "UnknownBlock"; readonly block: BlockId; readonly at: ErrorSite }
	| { readonly kind: "UnknownTarget"; readonly at: ErrorSite }
	| { readonly kind: "BadExpression"; readonly reason: string; readonly at: ErrorSite }
	| { readonly kind: "Cycle"; readonly path: readonly BlockId[]; readonly at: ErrorSite }
	| { readonly kind: "TooDeep"; readonly at: ErrorSite }
	| { readonly kind: "NoResult"; readonly block: BlockId; readonly at: ErrorSite }
	| { readonly kind: "FetchFailed"; readonly target: TargetKey; readonly error: string; readonly at: ErrorSite }
	| { readonly kind: "UnknownSlot"; readonly block: BlockId; readonly slot: string; readonly at: ErrorSite };

export interface ErrorSite {
	readonly block: BlockId;
	readonly reference: string;
}

export type Source =
	| { readonly kind: "block"; readonly target: TargetKey; readonly expression: string | null }
	| {
			readonly kind: "result";
			readonly target: TargetKey;
			readonly expression: string | null;
			readonly seq: number;
			readonly origin: EntryOrigin;
			readonly launch: LaunchId | null;
	  }
	| { readonly kind: "external"; readonly target: TargetKey; readonly expression: string | null; readonly fetchedAt: number };

export type CompileResult =
	| { readonly kind: "Ok"; readonly text: string; readonly sources: readonly Source[] }
	| { readonly kind: "Err"; readonly error: CompileError };

export interface CompileInput {
	readonly blocks: ReadonlyMap<BlockId, BlockContent>;
	readonly fetches: FetchTable;
	readonly results: ResultTable;
}

export type LaunchKind = "prompt" | "orchestration";

export type LaunchCloser = "coordinator" | "human" | "run_finished";

export interface PendingEvent {
	readonly event: string;
	readonly maxSeq: number;
	readonly result: CompileResult;
}

export interface Launch {
	readonly id: LaunchId;
	readonly run: RunId | null;
	readonly session: string;
	readonly blocks: readonly BlockId[];
	readonly kind: LaunchKind;
	readonly snapshot: {
		readonly result: Extract<CompileResult, { kind: "Ok" }>;
		readonly fetches: readonly (readonly [TargetKey, FetchOutcome])[];
		readonly results: readonly (readonly [BlockId, BlockResult])[];
	};
	readonly agents: readonly string[];
	readonly baselines: readonly string[];
	readonly notified: CompileResult | null;
	readonly dirty: readonly (readonly [BlockId, number])[];
	readonly fetches: readonly (readonly [TargetKey, FetchOutcome])[];
	readonly closed: { readonly at: number; readonly by: LaunchCloser } | null;
}

export type RecordKind = "update" | "result" | "failure" | "retrospective";

export type EntryData =
	| { readonly type: "run_started"; readonly name: string }
	| { readonly type: "run_finished" }
	| { readonly type: "block_edited"; readonly block: BlockId; readonly field: BlockField; readonly text: string; readonly edit: number }
	| { readonly type: "block_added"; readonly block: BlockId; readonly title: string; readonly content: BlockContent }
	| { readonly type: "block_deleted"; readonly block: BlockId; readonly title: string; readonly content: BlockContent }
	| { readonly type: "content_replaced"; readonly block: BlockId; readonly content: BlockContent }
	| { readonly type: "blocks_reordered"; readonly order: readonly BlockId[] }
	| { readonly type: "progress_changed"; readonly block: BlockId; readonly progress: Progress }
	| { readonly type: "launch_created"; readonly launch: LaunchId; readonly kind: LaunchKind; readonly blocks: readonly BlockId[] }
	| { readonly type: "agent_bound"; readonly launch: LaunchId; readonly agent: string }
	| { readonly type: "launch_closed"; readonly launch: LaunchId }
	| { readonly type: "event_sent"; readonly event: string; readonly data: unknown }
	| { readonly type: "interrupted"; readonly block: BlockId; readonly request: string }
	| { readonly type: "check_reported"; readonly blocks: readonly BlockId[]; readonly version: string; readonly result: JudgeReport }
	| {
			readonly type: "post";
			readonly kind: RecordKind;
			readonly text: string;
			readonly block?: BlockId;
			readonly launch?: LaunchId;
			readonly quote?: string;
			readonly session?: string;
	  }
	| { readonly type: "update_due"; readonly due: number }
	| { readonly type: "update_snoozed"; readonly due: number };

export interface TimelineEntry {
	readonly seq: number;
	readonly at: number;
	readonly origin: EntryOrigin;
	readonly data: EntryData;
}

export type JudgeReport =
	| { readonly kind: "answers"; readonly answers: Readonly<Record<string, number>> }
	| { readonly kind: "judge_unavailable" };

export type FindingName = "compile" | "empty_expansion" | "render_error" | "render_pending" | "draft" | "outline";
export type Findings = Readonly<Record<FindingName, boolean>>; // true = fails

export type EventName =
	| "block_changed"
	| "launch_requested"
	| "stop_requested"
	| "status_changed"
	| "update_due"
	| "interrupted"
	| "revision_requested"
	| "agents_requested";

export type AgentList =
	| { readonly kind: "offline" }
	| { readonly kind: "unasked" }
	| { readonly kind: "pending" }
	| { readonly kind: "listed"; readonly names: readonly string[] }
	| { readonly kind: "unavailable"; readonly reason: string };
