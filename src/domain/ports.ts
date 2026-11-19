import type {
	AgentList,
	Block,
	BlockContent,
	BlockId,
	BlockResult,
	CompileInput,
	CompileResult,
	DocRef,
	ExternalTarget,
	FetchOutcome,
	FetchTable,
	FindingName,
	Findings,
	HumanField,
	JudgeReport,
	Launch,
	LaunchId,
	PlaybookDoc,
	Reference,
	ReferenceExpression,
	Revision,
	RunId,
	RunMeta,
	Status,
	Target,
	TargetKey,
	TimelineEntry,
} from "./model";
import type { EventPayload, Outcome, Request } from "./protocol";

export interface ReferencesModule {
	parseReferences(body: string): Reference[];
	parseTarget(text: string): Target | null;
	parseExpression(
		expression: string | null,
	): { readonly ok: true; readonly value: ReferenceExpression } | { readonly ok: false; readonly reason: string };
	targetKey(target: Target): TargetKey;
	closure(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): Set<BlockId>;
	externalTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): ExternalTarget[];
	resultTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): BlockId[];
	compile(order: readonly BlockId[], input: CompileInput): CompileResult;
	expandOne(block: BlockId, reference: Reference, input: CompileInput): CompileResult;
	unifiedDiff(before: string, after: string): string;
	replacePanel(
		design: string,
		id: string,
		replacement: string,
	): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: "NotFound" | "BadValue"; readonly reason: string };
}

export interface Fetcher {
	fetch(target: ExternalTarget, baseDir: string): Promise<FetchOutcome>;
}

export type ServiceRecord =
	| { readonly kind: "block"; readonly id: BlockId }
	| { readonly kind: "run"; readonly id: RunId }
	| { readonly kind: "launch"; readonly id: LaunchId };

export type ParsedFile =
	| { readonly ok: true; readonly doc: PlaybookDoc; readonly run: RunMeta | null }
	| { readonly ok: false; readonly error: string };

export type LaunchChanges = Partial<Pick<Launch, "agents" | "baselines" | "notified" | "dirty" | "fetches" | "closed">>;

export interface Store {
	readonly templatePath: string;
	readonly baseDir: string;
	path(ref: DocRef): string;
	readTemplate(): ParsedFile;
	runIds(): RunId[];
	readRun(run: RunId): ParsedFile;
	serialize(doc: PlaybookDoc, run: RunMeta | null): string;
	parse(text: string, expectRun: boolean): ParsedFile;
	write(ref: DocRef, text: string): void;
	mtime(ref: DocRef): number | null;
	readText(ref: DocRef): string | null;
	readServiceRecords(): ServiceRecord[];
	appendServiceRecord(record: ServiceRecord): void;
	readLog(ref: DocRef): { readonly entries: TimelineEntry[]; readonly launches: Map<LaunchId, Launch> };
	appendEntry(ref: DocRef, entry: TimelineEntry): void;
	appendLaunch(ref: DocRef, launch: Launch): void;
	appendLaunchUpdate(ref: DocRef, id: LaunchId, changes: LaunchChanges): void;
	readRevisions(ref: DocRef): Revision[];
	appendRevision(ref: DocRef, revision: Revision): void;
	saveAsset(bytes: Uint8Array, extension: string): string;
}

export interface RenderStatus {
	readonly blockError: boolean;
	readonly documentError: boolean;
	readonly pendingOverdue: boolean;
	readonly view: { readonly md: readonly string[]; readonly images: readonly string[] };
	readonly draftErrors: number;
}

export interface ChecksModule {
	findings(input: {
		readonly compiled: CompileResult;
		readonly expansions: readonly CompileResult[];
		readonly content: BlockContent;
		readonly render: RenderStatus;
	}): Findings;
	version(input: {
		readonly closure: ReadonlyMap<BlockId, string | null>;
		readonly results: readonly BlockResult[];
		readonly compiled: CompileResult;
	}): string;
	validateReport(result: JudgeReport): boolean;
	readonly questions: readonly { readonly id: string; readonly type: "bool"; readonly instructions: string; readonly threshold: number }[];
}

export type { FindingName };

export interface BlockView {
	readonly block: Block;
	readonly launchPending: boolean;
}

export interface DocView {
	readonly ref: DocRef;
	readonly title: string;
	readonly run: RunMeta | null;
	readonly blocks: readonly BlockView[];
	readonly errors: readonly string[];
}

export interface CoordinatorStatus {
	readonly connected: boolean;
	readonly session: string | null;
	readonly pane: string | null;
}

export interface HumanCommands {
	edit(ref: DocRef, block: BlockId, field: HumanField, expected: string, text: string): string | null;
	setTitle(ref: DocRef, expected: string, text: string): string | null;
	requestRevision(ref: DocRef, block: BlockId, text: string): string | null;
	setStatus(ref: DocRef, block: BlockId, status: Status): string | null;
	setAgent(ref: DocRef, block: BlockId, agent: string | null): string | null;
	setIsolated(ref: DocRef, block: BlockId, isolated: boolean): string | null;
	deleteBlock(ref: DocRef, block: BlockId): string | null;
	requestLaunch(ref: DocRef, blocks: readonly BlockId[]): string | null;
	requestStop(ref: DocRef, block: BlockId): string | null;
	saveImage(
		bytes: Uint8Array,
		mimeType: string,
	): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
}

export interface CoreApi extends HumanCommands {
	view(ref: DocRef): DocView;
	coordinator(): CoordinatorStatus;
	agents(): AgentList;
	requestAgents(): void;
	focusCoordinator(): Promise<string | null>;
	errors(): readonly string[];
	onChange(listener: (ref: DocRef | null) => void): () => void;
	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void;
}

export interface Connection {
	readonly id: number;
	send(frame: EventPayload): void;
	close(): void;
}

export interface K1Handler {
	connected(conn: Connection): void;
	disconnected(conn: Connection): void;
	handle(conn: Connection, requestId: string, request: Request): Promise<Outcome<unknown>>;
}

export type { FetchTable };
