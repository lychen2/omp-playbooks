import { tr } from "../../omomp-shared/i18n";
import type {
	AgentList,
	Block,
	BlockContent,
	BlockField,
	BlockId,
	BlockLock,
	BlockResult,
	CompileInput,
	CompileResult,
	DocRef,
	EditOrigin,
	EntryData,
	EntryOrigin,
	ExternalTarget,
	FetchOutcome,
	Findings,
	HumanField,
	JudgeReport,
	Launch,
	LaunchCloser,
	LaunchId,
	LaunchKind,
	PlaybookDoc,
	Progress,
	RecordKind,
	Revision,
	RunId,
	RunMeta,
	Status,
	TargetKey,
	TaskConfig,
	TimelineEntry,
} from "../domain/model";
import { coordinatorField, fieldText, freshProgress, humanFieldValid, idNumber, isOrchestration, withField } from "../domain/model";
import type {
	ChecksModule,
	Connection,
	CoordinatorStatus,
	CoreApi,
	DocView,
	Fetcher,
	K1Handler,
	LaunchChanges,
	ReferencesModule,
	RenderStatus,
	ServiceRecord,
	Store,
} from "../domain/ports";
import type { EventPayload, Outcome, Request, RunSummary } from "../domain/protocol";
import { fail, ok } from "../domain/protocol";
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES } from "./draft/image";
import { launchFooter } from "./footer";
import { pageTimeline } from "./timeline";

export interface PaneControl {
	ownPane(): string | null;
	focusPane(pane: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CoreDeps {
	readonly store: Store;
	readonly references: ReferencesModule;
	readonly fetcher: Fetcher;
	readonly checks: ChecksModule;
	readonly panes: PaneControl;
	readonly now?: () => number;
}

type DocKey = "template" | RunId;

interface DocState {
	readonly ref: DocRef;
	title: string;
	blocks: Block[];
	run: RunMeta | null;
	locks: Map<BlockId, BlockLock>;
	readonly contents: Map<BlockId, BlockContent>;
	lastDoc: PlaybookDoc;
	lastMtime: number;
	writeTimer: Timer | undefined;
	parseError: string | null;
	findings: Map<BlockId, Findings>;
	render: Map<BlockId, RenderStatus>;
	inspections: Map<string, { blocks: BlockId[]; version: string; stale: boolean; report: JudgeReport | null }>;
	revisions: Revision[];
	readonly log: DocLog;
}

interface DocLog {
	readonly entries: TimelineEntry[];
	readonly results: Map<BlockId, BlockResult>;
	readonly pending: Set<string>;
	retrospective: boolean;
	readonly fired: Set<number>;
	lastUpdateAt: number | null;
}

function noteEntry(log: DocLog, entry: TimelineEntry): void {
	const data = entry.data;
	if (data.type === "post") {
		if (data.kind === "result" && data.block !== undefined)
			log.results.set(data.block, { text: data.text, at: entry.at, seq: entry.seq, origin: entry.origin, launch: data.launch ?? null });
		if (data.kind === "retrospective") log.retrospective = true;
		if (data.kind === "update") log.lastUpdateAt = entry.at;
	} else if (data.type === "event_sent" && data.event === "launch_requested") {
		for (const block of requestedBlocks(data.data)) log.pending.add(block);
	} else if (data.type === "launch_created") {
		for (const block of data.blocks) log.pending.delete(block);
	} else if (data.type === "update_due") {
		log.fired.add(data.due);
	}
}

function newLog(entries: TimelineEntry[]): DocLog {
	const log: DocLog = { entries, results: new Map(), pending: new Set(), retrospective: false, fired: new Set(), lastUpdateAt: null };
	for (const entry of entries) noteEntry(log, entry);
	return log;
}

interface FinishedRun {
	readonly meta: RunMeta;
	readonly done: number;
	readonly total: number;
	retrospective: boolean;
	readonly inspections: DocState["inspections"];
}

interface LaunchState {
	record: Launch;
	pending: { event: string; maxSeq: number; result: CompileResult } | null;
	deadline: number | null;
	timer: Timer | undefined;
	generation: number;
	judging: boolean;
}

interface ConnState {
	conn: Connection;
	session: string | null;
	pane: string | null;
	agents: AgentList;
}

const JUDGE_DELAY_MS = 2_000;
const WRITE_DELAY_MS = 1_000;
const DISK_POLL_MS = 1_000;
const ERRORS_KEPT = 200;
const AGENTS_WAIT_MS = 5_000;

function keyOf(ref: DocRef): DocKey {
	return ref.kind === "template" ? "template" : ref.run;
}
function refOf(key: DocKey): DocRef {
	return key === "template" ? { kind: "template" } : { kind: "run", run: key };
}
function keyOfRun(run: RunId | null | undefined): DocKey {
	return run ?? "template";
}
function runField(doc: { readonly run: RunMeta | null }): { run?: RunId } {
	return doc.run ? { run: doc.run.id } : {};
}
function sameResult(a: CompileResult | null, b: CompileResult | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind !== b.kind) return false;
	if (a.kind === "Ok" && b.kind === "Ok") return a.text === b.text;
	return JSON.stringify(a) === JSON.stringify(b);
}
function sameProgress(a: Progress, b: Progress): boolean {
	if (a.kind === "untracked" || b.kind === "untracked") return a.kind === b.kind;
	return a.status === b.status && a.report === b.report;
}
function isRetrospective(entry: TimelineEntry): boolean {
	return entry.data.type === "post" && entry.data.kind === "retrospective";
}
function progressCounts(blocks: readonly Block[]): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const block of blocks) {
		if (block.progress.kind !== "tracked") continue;
		total++;
		if (block.progress.status === "done") done++;
	}
	return { done, total };
}
function requestedBlocks(data: unknown): readonly string[] {
	if (typeof data !== "object" || data === null || !("blocks" in data) || !Array.isArray(data.blocks)) return [];
	return data.blocks.filter((value): value is string => typeof value === "string");
}

export function wireBlock(block: Block): Record<string, unknown> {
	const content = block.content;
	const progress =
		block.progress.kind === "untracked"
			? { task: false }
			: { status: block.progress.status, ...(block.progress.report === null ? {} : { report: block.progress.report }) };
	switch (content.kind) {
		case "task":
			return {
				id: block.id,
				kind: "task",
				title: block.title,
				body: content.body,
				...(content.agent === undefined ? {} : { agent: content.agent }),
				...(content.isolated === undefined ? {} : { isolated: content.isolated }),
				...progress,
			};
		case "design":
			return { id: block.id, kind: "design", title: block.title, requirement: content.requirement, design: content.design, ...progress };
	}
}

function taskConfig(content: BlockContent): TaskConfig {
	return content.kind === "task" ? { agent: content.agent, isolated: content.isolated } : {};
}

function withConfig(content: Extract<BlockContent, { kind: "task" }>, config: TaskConfig): BlockContent {
	return {
		kind: "task",
		body: content.body,
		...(config.agent === undefined ? {} : { agent: config.agent }),
		...(config.isolated === undefined ? {} : { isolated: config.isolated }),
	};
}

function sharedConfig(contents: readonly BlockContent[]): TaskConfig {
	const configs = contents.map(taskConfig);
	const shared = <K extends keyof TaskConfig>(key: K): TaskConfig[K] => {
		const first = configs[0]?.[key];
		return first !== undefined && configs.every((config) => config[key] === first) ? first : undefined;
	};
	const agent = shared("agent");
	const isolated = shared("isolated");
	return { ...(agent === undefined ? {} : { agent }), ...(isolated === undefined ? {} : { isolated }) };
}

function merged<T>(disk: T, written: T, current: T): T {
	return disk === written || disk === current ? current : disk;
}

export class Core implements CoreApi, K1Handler {
	readonly #store: Store;
	readonly #refs: ReferencesModule;
	readonly #fetcher: Fetcher;
	readonly #checks: ChecksModule;
	readonly #panes: PaneControl;
	readonly #now: () => number;

	readonly #docs = new Map<DocKey, DocState>();
	readonly #finished = new Map<RunId, FinishedRun>();
	readonly #runOrder: RunId[] = [];
	readonly #launches = new Map<LaunchId, LaunchState>();
	readonly #finishedLaunches = new Map<LaunchId, RunId>();
	readonly #fetches = new Map<TargetKey, FetchOutcome>();
	readonly #finishedTargets = new Set<TargetKey>();
	readonly #inflight = new Map<TargetKey, Promise<FetchOutcome>>();
	readonly #listeners = new Set<(ref: DocRef | null) => void>();
	readonly #reminders = new Map<RunId, Timer>();
	readonly #errors: string[] = [];

	#maxBlock = 0;
	#maxRun = 0;
	#maxLaunch = 0;
	#editSeq = 0;
	#eventSeq = 0;
	#agentsAsked = 0;
	#conn: ConnState | null = null;
	#diskTimer: Timer | undefined;

	constructor(deps: CoreDeps) {
		this.#store = deps.store;
		this.#refs = deps.references;
		this.#fetcher = deps.fetcher;
		this.#checks = deps.checks;
		this.#panes = deps.panes;
		this.#now = deps.now ?? Date.now;
	}

	load(): string | null {
		const template = this.#store.readTemplate();
		if (!template.ok) return template.error;
		this.#loadLive({ kind: "template" }, template.doc, null);
		for (const record of this.#store.readServiceRecords()) this.#noteRecord(record);
		for (const run of this.#store.runIds()) {
			const parsed = this.#store.readRun(run);
			if (!parsed.ok || parsed.run === null) {
				this.#noteError(
					tr(
						`Run ${run} file could not be parsed: ${parsed.ok ? "missing run mapping" : parsed.error}`,
						`Run ${run} 的文件不能解析：${parsed.ok ? "缺少 run 映射" : parsed.error}`,
					),
				);
				continue;
			}
			this.#maxRun = Math.max(this.#maxRun, idNumber(run));
			this.#runOrder.push(run);
			for (const block of parsed.doc.blocks) this.#maxBlock = Math.max(this.#maxBlock, idNumber(block.id));
			if (parsed.run.status === "finished") this.#loadFinished(parsed.doc, parsed.run);
			else this.#loadLive({ kind: "run", run }, parsed.doc, parsed.run);
		}
		for (const doc of this.#docs.values()) for (const block of doc.blocks) this.#maxBlock = Math.max(this.#maxBlock, idNumber(block.id));
		for (const doc of this.#docs.values()) if (doc.run?.status === "running") this.#scheduleReminder(doc.run.id, true);
		this.#diskTimer = setInterval(() => this.#pollDisk(), DISK_POLL_MS);
		for (const key of this.#docs.keys()) void this.#recomputeChecks(key);
		return null;
	}

	stop(): void {
		clearInterval(this.#diskTimer);
		for (const timer of this.#reminders.values()) clearTimeout(timer);
		for (const launch of this.#launches.values()) clearTimeout(launch.timer);
		for (const doc of this.#docs.values()) {
			if (doc.writeTimer) {
				clearTimeout(doc.writeTimer);
				this.#writeNow(doc);
			}
		}
	}

	#newDocState(
		ref: DocRef,
		doc: PlaybookDoc,
		run: RunMeta | null,
		entries: TimelineEntry[],
		inspections: DocState["inspections"] = new Map(),
	): DocState {
		return {
			ref,
			title: doc.title,
			blocks: [...doc.blocks],
			run,
			locks: new Map(doc.blocks.map((block) => [block.id, { kind: "none" }])),
			contents: new Map(doc.blocks.map((block) => [block.id, block.content])),
			lastDoc: doc,
			lastMtime: this.#store.mtime(ref) ?? 0,
			writeTimer: undefined,
			parseError: null,
			findings: new Map(),
			render: new Map(),
			inspections,
			revisions: this.#store.readRevisions(ref),
			log: newLog(entries),
		};
	}

	#readLog(ref: DocRef): { readonly entries: TimelineEntry[]; readonly launches: ReadonlyMap<LaunchId, Launch> } {
		const log = this.#store.readLog(ref);
		for (const launch of log.launches.values()) {
			this.#maxLaunch = Math.max(this.#maxLaunch, idNumber(launch.id));
			for (const [, seq] of launch.dirty) this.#editSeq = Math.max(this.#editSeq, seq);
		}
		for (const entry of log.entries) if (entry.data.type === "block_edited") this.#editSeq = Math.max(this.#editSeq, entry.data.edit);
		return log;
	}

	#loadLive(ref: DocRef, doc: PlaybookDoc, run: RunMeta | null): void {
		const log = this.#readLog(ref);
		this.#docs.set(keyOf(ref), this.#newDocState(ref, doc, run, log.entries));
		for (const launch of log.launches.values())
			this.#launches.set(launch.id, { record: launch, pending: null, deadline: null, timer: undefined, generation: 0, judging: false });
	}

	#loadFinished(doc: PlaybookDoc, meta: RunMeta): void {
		const log = this.#readLog({ kind: "run", run: meta.id });
		for (const id of log.launches.keys()) this.#finishedLaunches.set(id, meta.id);
		this.#finished.set(meta.id, {
			meta,
			...progressCounts(doc.blocks),
			retrospective: log.entries.some(isRetrospective),
			inspections: new Map(),
		});
	}

	#rememberTargets(doc: DocState): void {
		for (const target of this.#refs.externalTargets([...doc.contents.keys()], doc.contents))
			this.#finishedTargets.add(this.#refs.targetKey(target));
	}

	#evict(doc: DocState, meta: RunMeta): void {
		for (const [id, launch] of this.#launches) {
			if (launch.record.run !== meta.id) continue;
			this.#launches.delete(id);
			this.#finishedLaunches.set(id, meta.id);
		}
		this.#docs.delete(meta.id);
		this.#finished.set(meta.id, {
			meta,
			...progressCounts(doc.blocks),
			retrospective: doc.log.retrospective,
			inspections: doc.inspections,
		});
		this.#rememberTargets(doc);
		const referenced = new Set(this.#finishedTargets);
		for (const live of this.#docs.values()) {
			for (const target of this.#refs.externalTargets([...live.contents.keys()], live.contents))
				referenced.add(this.#refs.targetKey(target));
		}
		for (const key of this.#fetches.keys()) if (!referenced.has(key)) this.#fetches.delete(key);
	}

	#readFinished(run: RunId, finished: FinishedRun): Outcome<DocState> {
		const parsed = this.#store.readRun(run);
		if (!parsed.ok || parsed.run === null)
			return fail(
				"UnknownRun",
				tr(
					`Run ${run} file could not be parsed: ${parsed.ok ? "missing run mapping" : parsed.error}`,
					`Run ${run} 的文件不能解析：${parsed.ok ? "缺少 run 映射" : parsed.error}`,
				),
			);
		const ref: DocRef = { kind: "run", run };
		const doc = this.#newDocState(ref, parsed.doc, parsed.run, this.#store.readLog(ref).entries, finished.inspections);
		this.#rememberTargets(doc);
		return ok(doc);
	}

	#launchById(id: LaunchId): LaunchState | null {
		const live = this.#launches.get(id);
		if (live) return live;
		const run = this.#finishedLaunches.get(id);
		const record = run === undefined ? undefined : this.#store.readLog({ kind: "run", run }).launches.get(id);
		return record ? { record, pending: null, deadline: null, timer: undefined, generation: 0, judging: false } : null;
	}

	#isFinishedRun(run: RunId | undefined): boolean {
		return run !== undefined && this.#finished.has(run);
	}

	#noteRecord(record: ServiceRecord): void {
		switch (record.kind) {
			case "block":
				this.#maxBlock = Math.max(this.#maxBlock, idNumber(record.id));
				return;
			case "run":
				this.#maxRun = Math.max(this.#maxRun, idNumber(record.id));
				return;
			case "launch":
				this.#maxLaunch = Math.max(this.#maxLaunch, idNumber(record.id));
				return;
		}
	}

	#doc(ref: DocRef): DocState | null {
		return this.#docs.get(keyOf(ref)) ?? null;
	}
	#live(key: DocKey): DocState {
		const doc = this.#docs.get(key);
		if (!doc) throw new Error(`no document ${key}`);
		return doc;
	}
	#block(doc: DocState, id: BlockId): Block | null {
		return doc.blocks.find((block) => block.id === id) ?? null;
	}
	#isFinished(doc: DocState): boolean {
		return doc.run !== null && doc.run.status === "finished";
	}
	#emit(ref: DocRef | null): void {
		for (const listener of this.#listeners) listener(ref);
	}

	#append(doc: DocState, origin: EntryOrigin, data: EntryData): TimelineEntry {
		const entries = doc.log.entries;
		const entry: TimelineEntry = { seq: (entries.at(-1)?.seq ?? 0) + 1, at: this.#now(), origin, data };
		entries.push(entry);
		noteEntry(doc.log, entry);
		this.#store.appendEntry(doc.ref, entry);
		return entry;
	}

	async #fetchTarget(target: ExternalTarget, replace: boolean): Promise<FetchOutcome> {
		const key = this.#refs.targetKey(target);
		const existing = this.#fetches.get(key);
		if (existing && !replace) return existing;
		const inflight = this.#inflight.get(key);
		if (inflight) return inflight;
		const promise = this.#fetcher.fetch(target, this.#store.baseDir).then((outcome) => {
			this.#fetches.set(key, outcome);
			this.#inflight.delete(key);
			if (replace) {
				for (const doc of this.#docs.values()) {
					this.#invalidateInspections(doc, (blocks) =>
						this.#refs.externalTargets(blocks, doc.contents).some((other) => this.#refs.targetKey(other) === key),
					);
				}
			}
			return outcome;
		});
		this.#inflight.set(key, promise);
		this.#emit(null);
		return promise;
	}

	async #ensureFetched(doc: DocState, roots: readonly BlockId[]): Promise<void> {
		const targets = this.#refs.externalTargets(roots, doc.contents);
		await Promise.all(
			targets.filter((target) => !this.#fetches.has(this.#refs.targetKey(target))).map((target) => this.#fetchTarget(target, false)),
		);
	}

	#input(doc: DocState, fetches: ReadonlyMap<TargetKey, FetchOutcome>): CompileInput {
		return { blocks: doc.contents, fetches, results: doc.log.results };
	}

	async #compileNow(doc: DocState, blocks: readonly BlockId[]): Promise<CompileResult> {
		await this.#ensureFetched(doc, blocks);
		return this.#refs.compile(blocks, this.#input(doc, this.#fetches));
	}

	#applyEdit(doc: DocState, origin: EditOrigin, change: EditChange): number {
		const seq = ++this.#editSeq;
		const changesContents =
			change.kind === "content" ||
			change.kind === "insert" ||
			change.kind === "delete" ||
			(change.kind === "field" && change.field !== "title");
		const beforeContents = changesContents ? new Map(doc.contents) : null;
		let touched: BlockId | null = null;
		let notifies = origin !== "coordinator";
		switch (change.kind) {
			case "field": {
				const index = doc.blocks.findIndex((block) => block.id === change.block);
				const next = withField(doc.blocks[index]!, change.field, change.text);
				if (next === null) throw new Error(`block ${change.block} has no field ${change.field}`);
				doc.blocks[index] = next;
				doc.contents.set(change.block, next.content);
				touched = change.block;
				if (change.field === "design") notifies = true;
				this.#append(doc, origin, { type: "block_edited", block: change.block, field: change.field, text: change.text, edit: seq });
				break;
			}
			case "content": {
				const index = doc.blocks.findIndex((block) => block.id === change.block);
				doc.blocks[index] = { ...doc.blocks[index]!, content: change.content, progress: change.progress };
				doc.contents.set(change.block, change.content);
				touched = change.block;
				this.#append(doc, origin, { type: "content_replaced", block: change.block, content: change.content });
				this.#append(doc, origin, { type: "progress_changed", block: change.block, progress: change.progress });
				break;
			}
			case "config": {
				const index = doc.blocks.findIndex((block) => block.id === change.block);
				const current = doc.blocks[index]!;
				if (current.content.kind !== "task") throw new Error(`block ${change.block} is not a task block`);
				const content = withConfig(current.content, change.config);
				doc.blocks[index] = { ...current, content };
				doc.contents.set(change.block, content);
				this.#append(doc, origin, { type: "content_replaced", block: change.block, content });
				break;
			}
			case "progress": {
				const index = doc.blocks.findIndex((block) => block.id === change.block);
				doc.blocks[index] = { ...doc.blocks[index]!, progress: change.progress };
				this.#append(doc, origin, { type: "progress_changed", block: change.block, progress: change.progress });
				break;
			}
			case "insert": {
				const index = change.after === null ? doc.blocks.length : doc.blocks.findIndex((block) => block.id === change.after) + 1;
				doc.blocks.splice(index, 0, change.block);
				doc.contents.set(change.block.id, change.block.content);
				doc.locks.set(change.block.id, { kind: "none" });
				touched = change.block.id;
				this.#append(doc, origin, {
					type: "block_added",
					block: change.block.id,
					title: change.block.title,
					content: change.block.content,
				});
				break;
			}
			case "delete": {
				const index = doc.blocks.findIndex((block) => block.id === change.block);
				const [removed] = doc.blocks.splice(index, 1);
				doc.contents.delete(change.block);
				doc.locks.delete(change.block);
				touched = change.block;
				if (removed)
					this.#append(doc, origin, { type: "block_deleted", block: removed.id, title: removed.title, content: removed.content });
				break;
			}
			case "reorder": {
				const byId = new Map(doc.blocks.map((block) => [block.id, block]));
				if (change.order.length !== byId.size || new Set(change.order).size !== byId.size || change.order.some((id) => !byId.has(id))) {
					throw new Error("reorder needs a permutation of the document's blocks");
				}
				doc.blocks = change.order.map((id) => byId.get(id)!);
				this.#append(doc, origin, { type: "blocks_reordered", order: change.order });
				break;
			}
		}
		if (touched !== null && beforeContents !== null) {
			const changed = touched;
			this.#invalidateInspections(
				doc,
				(blocks) => this.#refs.closure(blocks, beforeContents).has(changed) || this.#refs.closure(blocks, doc.contents).has(changed),
			);
			if (notifies) this.#markDirty(doc, changed, seq, beforeContents);
		}
		this.#scheduleWrite(doc);
		this.#afterChange(doc);
		return seq;
	}

	#invalidateInspections(doc: DocState, affects: (blocks: readonly BlockId[]) => boolean): void {
		for (const [setKey, inspection] of doc.inspections) {
			if (inspection.stale || !affects(inspection.blocks)) continue;
			doc.inspections.set(setKey, { ...inspection, stale: true, report: null });
		}
	}

	#markDirty(doc: DocState, block: BlockId, seq: number, beforeContents: ReadonlyMap<BlockId, BlockContent>): void {
		const key = keyOf(doc.ref);
		for (const launch of this.#launches.values()) {
			if (keyOfRun(launch.record.run) !== key || launch.record.closed !== null) continue;
			const inBefore = this.#refs.closure(launch.record.blocks, beforeContents).has(block);
			const inAfter = this.#refs.closure(launch.record.blocks, doc.contents).has(block);
			if (!inBefore && !inAfter) continue;
			const dirty = new Map(launch.record.dirty);
			dirty.set(block, seq);
			this.#setLaunch(launch, { ...launch.record, dirty: [...dirty] });
			launch.deadline = this.#now() + JUDGE_DELAY_MS;
			this.#scheduleJudge(launch);
		}
	}

	#afterChange(doc: DocState): void {
		void this.#recomputeChecks(keyOf(doc.ref));
		this.#emit(doc.ref);
	}

	#scheduleWrite(doc: DocState): void {
		if (doc.writeTimer) return;
		doc.writeTimer = setTimeout(() => {
			doc.writeTimer = undefined;
			this.#writeNow(doc);
		}, WRITE_DELAY_MS);
	}

	#writeNow(doc: DocState): void {
		this.#pollDoc(doc);
		if (doc.parseError !== null) return;
		const snapshot: PlaybookDoc = { title: doc.title, blocks: [...doc.blocks] };
		this.#store.write(doc.ref, this.#store.serialize(snapshot, doc.run));
		doc.lastDoc = snapshot;
		doc.lastMtime = this.#store.mtime(doc.ref) ?? doc.lastMtime;
	}

	#writeRunNow(doc: DocState): void {
		if (doc.writeTimer) {
			clearTimeout(doc.writeTimer);
			doc.writeTimer = undefined;
		}
		this.#writeNow(doc);
	}

	#pollDisk(): void {
		for (const doc of this.#docs.values()) this.#pollDoc(doc);
	}

	#pollDoc(doc: DocState): void {
		const mtime = this.#store.mtime(doc.ref);
		if (mtime === null || mtime === doc.lastMtime) return;
		const text = this.#store.readText(doc.ref);
		if (text === null) return;
		doc.lastMtime = mtime;
		if (text === this.#store.serialize(doc.lastDoc, doc.run)) {
			if (doc.parseError !== null) {
				doc.parseError = null;
				this.#emit(doc.ref);
			}
			return;
		}
		const parsed = this.#store.parse(text, doc.run !== null);
		if (!parsed.ok) {
			doc.parseError = parsed.error;
			this.#emit(doc.ref);
			return;
		}
		if (doc.parseError !== null) {
			doc.parseError = null;
			this.#emit(doc.ref);
		}
		this.#applyDisk(doc, parsed.doc);
		doc.lastDoc = parsed.doc;
	}

	#applyDisk(doc: DocState, next: PlaybookDoc): void {
		const before = new Map(doc.lastDoc.blocks.map((block) => [block.id, block]));
		const after = new Map(next.blocks.map((block) => [block.id, block]));
		if (next.title !== doc.lastDoc.title) {
			doc.title = next.title;
			this.#scheduleWrite(doc);
			this.#emit(doc.ref);
		}
		for (const id of before.keys()) {
			if (after.has(id) || !this.#block(doc, id)) continue;
			this.#applyEdit(doc, "disk", { kind: "delete", block: id });
		}
		next.blocks.forEach((block, index) => {
			const current = this.#block(doc, block.id);
			if (!current) {
				const afterId = index === 0 ? null : (next.blocks[index - 1]?.id ?? null);
				this.#maxBlock = Math.max(this.#maxBlock, idNumber(block.id));
				this.#applyEdit(doc, "disk", { kind: "insert", after: afterId && this.#block(doc, afterId) ? afterId : null, block });
				return;
			}
			// Compare with the last written content, not the current block (README §S2): unchanged
			// fields on disk must not overwrite edits made since the last write-back.
			const previous = before.get(block.id) ?? current;
			if (block.content.kind !== current.content.kind) {
				if (block.content.kind === previous.content.kind) return;
				if (block.title !== previous.title && block.title !== current.title)
					this.#applyEdit(doc, "disk", { kind: "field", block: block.id, field: "title", text: block.title });
				this.#applyEdit(doc, "disk", { kind: "content", block: block.id, content: block.content, progress: block.progress });
				return;
			}
			for (const field of ["title", "body", "requirement", "design"] as const) {
				const text = fieldText(block, field);
				if (text === null || text === fieldText(previous, field) || text === fieldText(current, field)) continue;
				this.#applyEdit(doc, "disk", { kind: "field", block: block.id, field, text });
			}
			if (block.content.kind === "task" && current.content.kind === "task") {
				const disk = taskConfig(block.content);
				const written = taskConfig(previous.content);
				const mine = taskConfig(current.content);
				const config = {
					agent: merged(disk.agent, written.agent, mine.agent),
					isolated: merged(disk.isolated, written.isolated, mine.isolated),
				};
				if (config.agent !== mine.agent || config.isolated !== mine.isolated)
					this.#applyEdit(doc, "disk", { kind: "config", block: block.id, config });
			}
			if (!sameProgress(block.progress, previous.progress) && !sameProgress(block.progress, current.progress))
				this.#applyEdit(doc, "disk", { kind: "progress", block: block.id, progress: block.progress });
		});
		const onDisk = new Set(next.blocks.map((block) => block.id));
		const diskOrder = next.blocks.map((block) => block.id);
		let slot = 0;
		const order = doc.blocks.map((block) => (onDisk.has(block.id) ? diskOrder[slot++]! : block.id));
		if (order.join() !== doc.blocks.map((block) => block.id).join()) this.#applyEdit(doc, "disk", { kind: "reorder", order });
	}

	#setLaunch(launch: LaunchState, record: Launch): void {
		const previous = launch.record;
		launch.record = record;
		const changes: LaunchChanges = {
			...(record.agents === previous.agents ? {} : { agents: record.agents }),
			...(record.baselines === previous.baselines ? {} : { baselines: record.baselines }),
			...(record.notified === previous.notified ? {} : { notified: record.notified }),
			...(record.dirty === previous.dirty ? {} : { dirty: record.dirty }),
			...(record.fetches === previous.fetches ? {} : { fetches: record.fetches }),
			...(record.closed === previous.closed ? {} : { closed: record.closed }),
		};
		this.#store.appendLaunchUpdate(refOf(keyOfRun(record.run)), record.id, changes);
	}

	#isActive(launch: LaunchState): boolean {
		const doc = this.#docs.get(keyOfRun(launch.record.run));
		return doc !== undefined && !this.#isFinished(doc) && launch.record.closed === null && this.#conn?.session === launch.record.session;
	}

	#scheduleJudge(launch: LaunchState): void {
		clearTimeout(launch.timer);
		launch.timer = undefined;
		if (launch.deadline === null) return;
		const wait = Math.max(0, launch.deadline - this.#now());
		launch.timer = setTimeout(() => {
			launch.timer = undefined;
			void this.#judge(launch);
		}, wait);
	}

	async #judge(launch: LaunchState): Promise<void> {
		if (!this.#isActive(launch) || launch.pending !== null || launch.judging) return;
		if (launch.record.dirty.length === 0) return;
		if (launch.deadline !== null && launch.deadline > this.#now()) return;
		const doc = this.#docs.get(keyOfRun(launch.record.run))!;
		const maxSeq = Math.max(...launch.record.dirty.map(([, seq]) => seq));
		const changed = launch.record.dirty.map(([block]) => block);
		const generation = launch.generation;
		launch.judging = true;
		const fetches = await this.#launchFetches(launch);
		launch.judging = false;
		if (generation !== launch.generation || !this.#isActive(launch) || launch.pending !== null) return;
		const result = this.#launchText(
			doc,
			launch.record.blocks,
			launch.record.kind,
			this.#refs.compile(launch.record.blocks, this.#input(doc, fetches)),
		);
		const baseline = launch.record.baselines.at(-1)!;
		const dropUpTo = (notified: CompileResult | null): void => {
			this.#setLaunch(launch, { ...launch.record, notified, dirty: launch.record.dirty.filter(([, seq]) => seq > maxSeq) });
		};
		if (result.kind === "Ok" && result.text === baseline) {
			dropUpTo(null);
		} else if (!sameResult(result, launch.record.notified)) {
			const id = `e${++this.#eventSeq}`;
			launch.pending = { event: id, maxSeq, result };
			this.#send({
				event: "block_changed",
				data: {
					id,
					launch: { id: launch.record.id, kind: launch.record.kind, ...(launch.record.run === null ? {} : { run: launch.record.run }) },
					agents: launch.record.agents,
					changed,
					diff: result.kind === "Ok" ? this.#refs.unifiedDiff(baseline, result.text) : "",
					current: result,
				},
			});
		} else {
			dropUpTo(launch.record.notified);
		}
		this.#emit(refOf(keyOfRun(launch.record.run)));
		if (launch.pending === null && launch.record.dirty.length > 0 && launch.deadline !== null && launch.deadline <= this.#now())
			void this.#judge(launch);
	}

	async #launchFetches(launch: LaunchState): Promise<Map<TargetKey, FetchOutcome>> {
		const doc = this.#docs.get(keyOfRun(launch.record.run))!;
		for (;;) {
			const table = new Map(launch.record.fetches);
			const added: [TargetKey, FetchOutcome][] = [];
			for (const target of this.#refs.externalTargets(launch.record.blocks, doc.contents)) {
				const key = this.#refs.targetKey(target);
				if (table.has(key)) continue;
				const outcome = this.#fetches.get(key) ?? (await this.#fetchTarget(target, false));
				table.set(key, outcome);
				added.push([key, outcome]);
			}
			if (added.length === 0) return table;
			const recorded = new Set(launch.record.fetches.map(([key]) => key));
			this.#setLaunch(launch, { ...launch.record, fetches: [...launch.record.fetches, ...added.filter(([key]) => !recorded.has(key))] });
		}
	}

	#closeLaunch(launch: LaunchState, by: LaunchCloser, origin: EntryOrigin): void {
		launch.generation++;
		launch.pending = null;
		launch.deadline = null;
		clearTimeout(launch.timer);
		launch.timer = undefined;
		this.#setLaunch(launch, { ...launch.record, closed: { at: this.#now(), by } });
		this.#append(this.#live(keyOfRun(launch.record.run)), origin, { type: "launch_closed", launch: launch.record.id });
	}

	#launchText(doc: DocState, blocks: readonly BlockId[], kind: LaunchKind, result: CompileResult): CompileResult {
		if (result.kind === "Err" || kind === "orchestration") return result;
		const roots = blocks.flatMap((id) => {
			const block = this.#block(doc, id);
			return block && block.progress.kind === "tracked" ? [{ id, title: block.title }] : [];
		});
		return roots.length === 0 ? result : { ...result, text: `${result.text}\n\n${launchFooter(this.#store.path(doc.ref), roots)}` };
	}

	#send(payload: EventPayload): boolean {
		if (!this.#conn || this.#conn.session === null) return false;
		this.#conn.conn.send(payload);
		const run = payload.event === "block_changed" ? payload.data.launch.run : payload.data.run;
		this.#append(this.#live(keyOfRun(run)), "service", { type: "event_sent", event: payload.event, data: payload.data });
		return true;
	}

	#scheduleReminder(run: RunId, startup = false): void {
		const existing = this.#reminders.get(run);
		clearTimeout(existing);
		this.#reminders.delete(run);
		const doc = this.#docs.get(run);
		const meta = doc?.run;
		if (!doc || !meta || meta.status !== "running" || meta.updateDue === null) return;
		const due = meta.updateDue;
		if (doc.log.fired.has(due)) return;
		const wait = Math.max(0, due - this.#now());
		if (startup && wait === 0) {
			this.#fireReminder(run, due);
			return;
		}
		this.#reminders.set(
			run,
			setTimeout(() => this.#fireReminder(run, due), wait),
		);
	}

	#fireReminder(run: RunId, due: number): void {
		this.#reminders.delete(run);
		const doc = this.#docs.get(run);
		if (doc?.run?.status !== "running" || doc.run.updateDue !== due) return;
		this.#append(doc, "service", { type: "update_due", due });
		this.#send({ event: "update_due", data: { run, due, last_update: doc.log.lastUpdateAt } });
		this.#emit(doc.ref);
	}

	#setDue(doc: DocState, due: number | null): void {
		doc.run = { ...doc.run!, updateDue: due };
		this.#writeRunNow(doc);
		this.#scheduleReminder(doc.run.id);
	}

	async #recomputeChecks(key: DocKey): Promise<void> {
		const doc = this.#docs.get(key);
		if (!doc) return;
		await this.#ensureFetched(
			doc,
			doc.blocks.map((block) => block.id),
		);
		const input = this.#input(doc, this.#fetches);
		let changed = false;
		for (const block of doc.blocks) {
			const next = this.#findings(doc, block, input);
			const previous = doc.findings.get(block.id);
			if (JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
			doc.findings.set(block.id, next);
		}
		for (const [setKey, inspection] of doc.inspections) {
			if (inspection.report === null) continue;
			if (this.#version(doc, inspection.blocks, input) !== inspection.version) {
				doc.inspections.set(setKey, { ...inspection, report: null });
				changed = true;
			}
		}
		if (changed) this.#emit(doc.ref);
	}

	#findings(doc: DocState, block: Block, input: CompileInput): Findings {
		const compiled = this.#refs.compile([block.id], input);
		const expansions =
			block.content.kind === "task"
				? this.#refs.parseReferences(block.content.body).map((reference) => this.#refs.expandOne(block.id, reference, input))
				: [];
		const render = doc.render.get(block.id) ?? {
			blockError: false,
			documentError: false,
			pendingOverdue: false,
			view: { md: [], images: [] },
			draftErrors: 0,
		};
		return this.#checks.findings({ compiled, expansions, content: block.content, render });
	}

	#version(doc: DocState, blocks: readonly BlockId[], input: CompileInput): string {
		const contents = doc.contents;
		const closure = new Map<BlockId, string | null>();
		for (const id of this.#refs.closure(blocks, contents)) {
			const content = contents.get(id);
			closure.set(id, content === undefined ? null : content.kind === "task" ? content.body : JSON.stringify(content));
		}
		const results = this.#refs.resultTargets(blocks, contents).flatMap((id) => {
			const result = input.results.get(id);
			return result ? [result] : [];
		});
		return this.#checks.version({ closure, results, compiled: this.#refs.compile(blocks, input) });
	}

	#inspectState(doc: DocState, blocks: readonly BlockId[]): unknown {
		const input = this.#input(doc, this.#fetches);
		const version = this.#version(doc, blocks, input);
		const setKey = blocks.join(",");
		const previous = doc.inspections.get(setKey);
		doc.inspections.set(setKey, {
			blocks: [...blocks],
			version,
			stale: false,
			report: previous?.version === version && !previous.stale ? previous.report : null,
		});
		return {
			blocks,
			source: Object.fromEntries(
				blocks.map((id) => {
					const content = this.#block(doc, id)?.content;
					return [
						id,
						content === undefined
							? null
							: content.kind === "task"
								? content.body
								: { requirement: content.requirement, design: content.design },
					];
				}),
			),
			compiled: this.#refs.compile(blocks, input),
			view: Object.fromEntries(blocks.map((id) => [id, doc.render.get(id)?.view ?? { md: [], images: [] }])),
			findings: Object.fromEntries(blocks.map((id) => [id, doc.findings.get(id) ?? null])),
			version,
		};
	}

	connected(_conn: Connection): void {}

	disconnected(conn: Connection): void {
		if (this.#conn?.conn !== conn) return;
		this.#conn = null;
		for (const doc of this.#docs.values()) {
			for (const [block, lock] of doc.locks) if (lock.kind === "coordinator") doc.locks.set(block, { kind: "none" });
		}
		for (const launch of this.#launches.values()) {
			launch.generation++;
			launch.pending = null;
			launch.judging = false;
		}
		this.#emit(null);
	}

	async handle(conn: Connection, requestId: string, request: Request): Promise<Outcome<unknown>> {
		if (request.op === "reveal") {
			const pane = this.#panes.ownPane();
			if (pane === null)
				return fail(
					"RevealFailed",
					tr("The document service is not in a pane managed by the session daemon", "文档服务不在 session daemon 托管的 pane 中"),
				);
			const shown = await this.#panes.focusPane(pane);
			return shown.ok ? ok(null) : fail("RevealFailed", shown.error);
		}
		if (this.#conn?.conn !== conn) {
			if (request.op !== "hello")
				return fail(
					this.#conn === null ? "NotHello" : "Busy",
					this.#conn === null
						? tr("The first request must be hello", "第一条请求必须是 hello")
						: tr("Another coordinator is already connected", "另一个协调者已连接"),
				);
			if (this.#conn !== null) return fail("Busy", tr("Another coordinator is already connected", "另一个协调者已连接"));
			this.#conn = { conn, session: null, pane: null, agents: { kind: "unasked" } };
		}
		const session = this.#conn.session;
		switch (request.op) {
			case "hello": {
				if (this.#conn.session !== null) return fail("Busy", tr("This connection has already sent hello", "本连接已 hello"));
				this.#conn.session = request.args.session;
				this.#conn.pane = request.args.pane ?? null;
				for (const launch of this.#launches.values()) {
					if (launch.record.session === request.args.session && launch.record.dirty.length > 0 && this.#isActive(launch)) {
						launch.deadline = this.#now();
						void this.#judge(launch);
					}
				}
				this.#emit(null);
				const pane = this.#panes.ownPane();
				return ok({ blocks: this.#docs.get("template")!.blocks.map((block) => block.id), runs: this.runs(), ...(pane ? { pane } : {}) });
			}
			case "lock": {
				const target = this.#target(request.args.run, request.args.block, true);
				if (!target.ok) return target;
				const { doc, block } = target.result;
				doc.locks.set(block.id, { kind: "coordinator", request: requestId });
				this.#emit(doc.ref);
				return ok({ block: wireBlock(block) });
			}
			case "unlock": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				const lock = doc.result.locks.get(request.args.block);
				if (lock?.kind === "coordinator" && lock.request === request.args.request) {
					doc.result.locks.set(request.args.block, { kind: "none" });
					this.#emit(doc.result.ref);
				}
				return ok(null);
			}
			case "read": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				if (request.args.block !== undefined) {
					const block = this.#block(doc.result, request.args.block);
					return block
						? ok(wireBlock(block))
						: fail("UnknownBlock", tr(`Block ${request.args.block} does not exist`, `块 ${request.args.block} 不存在`));
				}
				return ok({
					title: doc.result.title,
					blocks: doc.result.blocks.map(wireBlock),
					...(doc.result.run ? { run: doc.result.run } : {}),
				});
			}
			case "set": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc } = held.result;
				switch (request.args.field) {
					case "title":
						this.#applyEdit(doc, "coordinator", { kind: "field", block: request.args.block, field: "title", text: request.args.value });
						return ok(null);
					case "status": {
						const progress = this.#statusProgress(held.result.block, request.args.value);
						if (typeof progress === "string") return fail("BadValue", progress);
						this.#applyEdit(doc, "coordinator", { kind: "progress", block: request.args.block, progress });
						return ok(null);
					}
					case "task": {
						const block = held.result.block;
						if (block.content.kind !== "task")
							return fail("BadValue", tr("A design block cannot be declared as a non-task block", "设计块不能声明为非任务块"));
						if ((block.progress.kind === "tracked") === request.args.value) return ok(null);
						const progress: Progress = request.args.value ? { kind: "tracked", status: "todo", report: null } : { kind: "untracked" };
						this.#applyEdit(doc, "coordinator", { kind: "progress", block: request.args.block, progress });
						return ok(null);
					}
					case "agent":
					case "isolated": {
						const content = held.result.block.content;
						if (content.kind !== "task") return fail("BadValue", tr("A design block has no execution configuration", "设计块没有执行配置"));
						const value = request.args.value ?? undefined;
						const config = { ...taskConfig(content), [request.args.field]: value };
						this.#applyEdit(doc, "coordinator", { kind: "config", block: request.args.block, config });
						return ok(null);
					}
					default:
						return fail("BadValue", tr("Unknown field", "未知字段"));
				}
			}
			case "move": {
				const { block: id, after } = request.args;
				const held = this.#held(request.args.run, id);
				if (!held.ok) return held;
				const { doc } = held.result;
				if (after === id) return fail("BadValue", tr("A block cannot be moved after itself", "不能把块移到自己后面"));
				if (after !== null && !this.#block(doc, after))
					return fail("UnknownBlock", tr(`Block ${after} does not exist`, `块 ${after} 不存在`));
				const current = doc.blocks.map((block) => block.id);
				const rest = current.filter((other) => other !== id);
				const index = after === null ? 0 : rest.indexOf(after) + 1;
				const order = [...rest.slice(0, index), id, ...rest.slice(index)];
				if (order.join() !== current.join()) this.#applyEdit(doc, "coordinator", { kind: "reorder", order });
				return ok(null);
			}
			case "edit": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				const field = coordinatorField(block.content);
				const current = fieldText(block, field)!;
				const first = current.indexOf(request.args.find);
				if (first < 0)
					return fail(
						"NotFound",
						field === "body"
							? tr("The find text is not in the block body", "find 文本不在块正文中")
							: tr("The find text is not in the design draft", "find 文本不在设计稿中"),
					);
				if (current.indexOf(request.args.find, first + 1) >= 0)
					return fail("Ambiguous", tr("The find text occurs more than once", "find 文本出现多次"));
				const text = current.slice(0, first) + request.args.replace + current.slice(first + request.args.find.length);
				this.#applyEdit(doc, "coordinator", { kind: "field", block: block.id, field, text });
				return ok(null);
			}
			case "write": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				this.#applyEdit(doc, "coordinator", {
					kind: "field",
					block: block.id,
					field: coordinatorField(block.content),
					text: request.args.text,
				});
				return ok(null);
			}
			case "panel": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				const field = coordinatorField(block.content);
				const replaced = this.#refs.replacePanel(fieldText(block, field)!, request.args.panel, request.args.text);
				if (!replaced.ok) return fail(replaced.code, replaced.reason);
				this.#applyEdit(doc, "coordinator", { kind: "field", block: block.id, field, text: replaced.text });
				return ok(null);
			}
			case "insert": {
				if (this.#isFinishedRun(request.args.run)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				if (request.args.after !== undefined && !this.#block(doc.result, request.args.after))
					return fail("UnknownBlock", tr(`Block ${request.args.after} does not exist`, `块 ${request.args.after} 不存在`));
				const id = this.#allocateBlock(doc.result);
				const given = request.args.content;
				const content: BlockContent = given.kind === "task" ? given : { kind: "design", requirement: "", design: given.design };
				this.#applyEdit(doc.result, "coordinator", {
					kind: "insert",
					after: request.args.after ?? null,
					block: { id, title: request.args.title, progress: { kind: "tracked", status: "todo", report: null }, content },
				});
				return ok({ block: id });
			}
			case "revisions": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				const after = request.args.after ?? 0;
				const block = request.args.block;
				return ok({
					revisions: doc.result.revisions.filter((revision) => revision.seq > after && (block === undefined || revision.block === block)),
				});
			}
			case "delete": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				this.#applyEdit(held.result.doc, "coordinator", { kind: "delete", block: request.args.block });
				return ok(null);
			}
			case "refetch": {
				const fetched: { target: string; ok: boolean }[] = [];
				const targets: ExternalTarget[] = [];
				for (const text of request.args.targets) {
					const target = this.#refs.parseTarget(text);
					if (!target || target.kind === "block" || target.kind === "result")
						return fail("UnknownTarget", tr(`${text} is not an external target`, `${text} 不是外部目标`));
					targets.push(target);
				}
				for (const target of targets) {
					const outcome = await this.#fetchTarget(target, true);
					fetched.push({ target: this.#refs.targetKey(target), ok: outcome.ok });
				}
				for (const key of this.#docs.keys()) void this.#recomputeChecks(key);
				return ok({ fetched });
			}
			case "compile": {
				const doc = this.#blocksOf(request.args.run, request.args.blocks);
				if (!doc.ok) return doc;
				return ok(await this.#compileNow(doc.result, request.args.blocks));
			}
			case "inspect": {
				const doc = this.#blocksOf(request.args.run, request.args.blocks);
				if (!doc.ok) return doc;
				await this.#ensureFetched(doc.result, request.args.blocks);
				if (this.#docs.get(keyOf(doc.result.ref)) !== doc.result) {
					const input = this.#input(doc.result, this.#fetches);
					for (const id of request.args.blocks)
						doc.result.findings.set(id, this.#findings(doc.result, this.#block(doc.result, id)!, input));
				}
				return ok(this.#inspectState(doc.result, request.args.blocks));
			}
			case "report":
				return this.#report(request.args.run, request.args.blocks, request.args.version, request.args.result);
			case "launch":
				return this.#launch(session!, request.args.run, request.args.blocks);
			case "bind": {
				const launch = this.#owned(session!, request.args.launch);
				if (!launch.ok) return launch;
				if (launch.result.record.closed !== null) return fail("BadLaunch", tr("Launch is closed", "Launch 已关闭"));
				this.#setLaunch(launch.result, { ...launch.result.record, agents: [...launch.result.record.agents, request.args.agent] });
				this.#append(this.#live(keyOfRun(launch.result.record.run)), "coordinator", {
					type: "agent_bound",
					launch: request.args.launch,
					agent: request.args.agent,
				});
				this.#emit(refOf(keyOfRun(launch.result.record.run)));
				return ok(null);
			}
			case "rebase":
				return this.#rebase(session!, request.args.launch);
			case "close": {
				const launch = this.#owned(session!, request.args.launch);
				if (!launch.ok) return launch;
				if (launch.result.record.closed === null) this.#closeLaunch(launch.result, "coordinator", "coordinator");
				this.#emit(refOf(keyOfRun(launch.result.record.run)));
				return ok(null);
			}
			case "launch_info": {
				const launch = this.#launchById(request.args.launch);
				return launch
					? ok(launch.record)
					: fail("UnknownLaunch", tr(`Launch ${request.args.launch} does not exist`, `Launch ${request.args.launch} 不存在`));
			}
			case "start_run":
				return ok({ run: this.#startRun(request.args.name, request.args.update_every ?? null) });
			case "finish_run": {
				const result = this.#finishRun(request.args.run);
				return result === null ? ok(null) : result;
			}
			case "runs":
				return ok({ runs: this.runs() });
			case "timeline":
				return this.timeline(refOf(keyOfRun(request.args.run)), request.args.after, request.args.limit);
			case "post": {
				const args = request.args;
				const result = this.#post(
					args.run,
					args.kind,
					args.text,
					args.block ?? null,
					args.launch ?? null,
					args.next ?? null,
					args.quote ?? null,
					args.origin === "human" ? "human" : "coordinator",
					session,
				);
				return result;
			}
			case "snooze":
				return this.#snooze(request.args.run, request.args.after);
			case "ack": {
				for (const launch of this.#launches.values()) {
					if (launch.pending?.event !== request.args.event) continue;
					const pending = launch.pending;
					launch.pending = null;
					this.#setLaunch(launch, {
						...launch.record,
						notified: pending.result,
						dirty: launch.record.dirty.filter(([, seq]) => seq > pending.maxSeq),
					});
					if (launch.record.dirty.length > 0 && launch.deadline !== null && launch.deadline <= this.#now()) void this.#judge(launch);
					return ok(null);
				}
				return fail(
					"UnknownEvent",
					tr(`Event ${request.args.event} is not awaiting acknowledgement`, `事件 ${request.args.event} 不是待确认的事件`),
				);
			}
			case "agents": {
				if (this.#conn.agents.kind !== "pending")
					return fail("UnknownEvent", tr("There is no pending agents_requested response", "没有待回答的 agents_requested"));
				this.#conn.agents = request.args.result;
				this.#emit(null);
				return ok(null);
			}
		}
	}

	#docOf(run: RunId | undefined): Outcome<DocState> {
		const doc = this.#docs.get(run ?? "template");
		if (doc) return ok(doc);
		const finished = run === undefined ? undefined : this.#finished.get(run);
		return run !== undefined && finished
			? this.#readFinished(run, finished)
			: fail("UnknownRun", tr(`Run ${run} does not exist`, `Run ${run} 不存在`));
	}

	#target(run: RunId | undefined, id: BlockId, modifying: boolean): Outcome<{ doc: DocState; block: Block }> {
		if (modifying && this.#isFinishedRun(run)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		const doc = this.#docOf(run);
		if (!doc.ok) return doc;
		if (modifying && this.#isFinished(doc.result)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		const block = this.#block(doc.result, id);
		return block ? ok({ doc: doc.result, block }) : fail("UnknownBlock", tr(`Block ${id} does not exist`, `块 ${id} 不存在`));
	}

	#held(run: RunId | undefined, id: BlockId): Outcome<{ doc: DocState; block: Block }> {
		const target = this.#target(run, id, true);
		if (!target.ok) return target;
		const lock = target.result.doc.locks.get(id);
		return lock?.kind === "coordinator"
			? target
			: fail("NotLocked", tr(`This connection does not hold block ${id}'s lock`, `本连接不持有块 ${id} 的块锁`));
	}

	#blocksOf(run: RunId | undefined, blocks: readonly BlockId[]): Outcome<DocState> {
		const doc = this.#docOf(run);
		if (!doc.ok) return doc;
		for (const id of blocks)
			if (!this.#block(doc.result, id)) return fail("UnknownBlock", tr(`Block ${id} does not exist`, `块 ${id} 不存在`));
		return doc;
	}

	#owned(session: string, id: LaunchId): Outcome<LaunchState> {
		const launch = this.#launchById(id);
		if (!launch) return fail("UnknownLaunch", tr(`Launch ${id} does not exist`, `Launch ${id} 不存在`));
		if (launch.record.session !== session)
			return fail("NotOwner", tr(`Launch ${id} belongs to another session`, `Launch ${id} 属于其他会话`));
		return ok(launch);
	}

	#allocateBlock(doc: DocState): BlockId {
		const docMax = Math.max(0, ...doc.blocks.map((block) => idNumber(block.id)));
		const n = Math.max(this.#maxBlock, docMax) + 1;
		this.#maxBlock = n;
		const id = `b${n}` as BlockId;
		this.#store.appendServiceRecord({ kind: "block", id });
		return id;
	}

	async #launch(session: string, run: RunId | undefined, blocks: readonly BlockId[]): Promise<Outcome<unknown>> {
		if (this.#isFinishedRun(run)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		const found = this.#docOf(run);
		if (!found.ok) return found;
		const docState = found.result;
		if (this.#isFinished(docState)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		if (blocks.length === 0) return fail("BadLaunch", tr("blocks is empty", "blocks 为空"));
		for (const id of blocks)
			if (!this.#block(docState, id)) return fail("UnknownBlock", tr(`Block ${id} does not exist`, `块 ${id} 不存在`));
		const before = this.#rootsError(docState, blocks);
		if (before) return fail("BadLaunch", before);
		await this.#ensureFetched(docState, blocks);
		if (this.#isFinished(docState)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		for (const id of blocks)
			if (!this.#block(docState, id)) return fail("UnknownBlock", tr(`Block ${id} does not exist`, `块 ${id} 不存在`));
		const after = this.#rootsError(docState, blocks);
		if (after) return fail("BadLaunch", after);
		const kind = this.#launchKind(docState, blocks);
		const bodies = docState.contents;
		const results = docState.log.results;
		const result = this.#launchText(docState, blocks, kind, this.#refs.compile(blocks, this.#input(docState, this.#fetches)));
		if (result.kind === "Err") return fail("CompileError", tr("Compilation failed", "编译失败"), result.error);
		const fetchKeys = this.#refs.externalTargets(blocks, bodies).map((target) => this.#refs.targetKey(target));
		const fetches = fetchKeys.flatMap((key) => {
			const outcome = this.#fetches.get(key);
			return outcome ? [[key, outcome] as const] : [];
		});
		const usedResults = this.#refs.resultTargets(blocks, bodies).flatMap((id) => {
			const value = results.get(id);
			return value ? [[id, value] as const] : [];
		});
		this.#maxLaunch++;
		const id = `l${this.#maxLaunch}` as LaunchId;
		this.#store.appendServiceRecord({ kind: "launch", id });
		const record: Launch = {
			id,
			run: docState.run?.id ?? null,
			session,
			blocks: [...blocks],
			kind,
			snapshot: { result, fetches, results: usedResults },
			agents: [],
			baselines: [result.text],
			notified: null,
			dirty: [],
			fetches,
			closed: null,
		};
		const state: LaunchState = { record, pending: null, deadline: null, timer: undefined, generation: 0, judging: false };
		this.#launches.set(id, state);
		this.#store.appendLaunch(docState.ref, record);
		this.#append(docState, "coordinator", { type: "launch_created", launch: id, kind: record.kind, blocks: record.blocks });
		this.#emit(docState.ref);
		const config = kind === "prompt" ? sharedConfig(blocks.map((block) => this.#block(docState, block)!.content)) : {};
		return ok({ launch: id, kind, text: result.text, ...config });
	}

	#rootsError(doc: DocState, blocks: readonly BlockId[]): string | null {
		const designs = blocks.filter((id) => this.#block(doc, id)!.content.kind === "design");
		if (designs.length > 0)
			return tr(
				`Design block${designs.length === 1 ? "" : "s"} ${designs.join(", ")} cannot be launched directly; reference the listed blocks from an execution block`,
				`设计块 ${designs.join(", ")} 不能直接启动：在执行块中引用它`,
			);
		const untracked = blocks.filter((id) => this.#block(doc, id)!.progress.kind === "untracked");
		if (untracked.length > 0)
			return tr(
				`Block${untracked.length === 1 ? "" : "s"} ${untracked.join(", ")} cannot be launched directly because task: false marks the listed blocks as non-task; reference the listed blocks from an execution block`,
				`块 ${untracked.join(", ")} 声明为非任务块（task: false），不能启动：在执行块中引用它`,
			);
		if (blocks.length > 1 && this.#launchKind(doc, blocks) === "orchestration")
			return tr("An orchestration block must be launched alone", "编排块只能单独启动");
		return null;
	}

	#launchKind(doc: DocState, blocks: readonly BlockId[]): LaunchKind {
		return blocks.some((id) => isOrchestration(this.#block(doc, id)!.content)) ? "orchestration" : "prompt";
	}

	async #rebase(session: string, id: LaunchId): Promise<Outcome<unknown>> {
		const owned = this.#owned(session, id);
		if (!owned.ok) return owned;
		const launch = owned.result;
		if (launch.record.closed !== null) return fail("BadLaunch", tr("Launch is closed", "Launch 已关闭"));
		const key = keyOfRun(launch.record.run);
		const generation = launch.generation;
		const accepted = this.#editSeq;
		const fetches = await this.#launchFetches(launch);
		const doc = this.#docs.get(key);
		if (!doc || this.#isFinished(doc)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		if (launch.record.closed !== null) return fail("BadLaunch", tr("Launch is closed", "Launch 已关闭"));
		if (launch.generation !== generation)
			return fail("BadLaunch", tr("Launch changed during rebase; rebase again", "Launch 在 rebase 期间已变化，请重新 rebase"));
		const missing = launch.record.blocks.filter((block) => !this.#block(doc, block));
		if (missing.length > 0)
			return fail(
				"BadLaunch",
				tr(`Deleted root block${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`, `根块 ${missing.join(", ")} 已删除`),
			);
		const roots = this.#rootsError(doc, launch.record.blocks);
		if (roots) return fail("BadLaunch", roots);
		if (this.#launchKind(doc, launch.record.blocks) !== launch.record.kind)
			return fail(
				"BadLaunch",
				tr(
					`Root blocks are no longer ${launch.record.kind === "prompt" ? "execution blocks" : "orchestration blocks"}; launch again`,
					`根块已不是${launch.record.kind === "prompt" ? "执行块" : "编排块"}：重新启动`,
				),
			);
		const result = this.#launchText(
			doc,
			launch.record.blocks,
			launch.record.kind,
			this.#refs.compile(launch.record.blocks, this.#input(doc, fetches)),
		);
		if (result.kind === "Err") return fail("CompileError", tr("Compilation failed", "编译失败"), result.error);
		launch.generation++;
		launch.pending = null;
		launch.judging = false;
		clearTimeout(launch.timer);
		launch.timer = undefined;
		const dirty = launch.record.dirty.filter(([, seq]) => seq > accepted);
		this.#setLaunch(launch, { ...launch.record, baselines: [...launch.record.baselines, result.text], notified: null, dirty });
		launch.deadline = dirty.length > 0 ? this.#now() + JUDGE_DELAY_MS : null;
		this.#scheduleJudge(launch);
		this.#emit(doc.ref);
		return ok({ baseline: result.text });
	}

	#report(run: RunId | undefined, blocks: readonly BlockId[], version: string, result: JudgeReport): Outcome<unknown> {
		const doc = this.#blocksOf(run, blocks);
		if (!doc.ok) return doc;
		if (!this.#checks.validateReport(result))
			return fail("BadReport", tr("report's result is incomplete or out of range", "report 的 result 不完整或越界"));
		const setKey = blocks.join(",");
		const inspection = doc.result.inspections.get(setKey);
		const current = this.#version(doc.result, blocks, this.#input(doc.result, this.#fetches));
		if (!inspection || inspection.stale || inspection.version !== version || current !== version) return ok(null);
		doc.result.inspections.set(setKey, { ...inspection, report: result });
		this.#append(doc.result, "coordinator", { type: "check_reported", blocks: [...blocks], version, result });
		this.#emit(doc.result.ref);
		return ok(null);
	}

	#startRun(name: string, updateEvery: number | null): RunId {
		const template = this.#docs.get("template")!;
		this.#maxRun++;
		const id = `r${this.#maxRun}` as RunId;
		this.#store.appendServiceRecord({ kind: "run", id });
		const started = this.#now();
		const meta: RunMeta = {
			id,
			name,
			status: "running",
			startedAt: started,
			finishedAt: null,
			updateEvery,
			updateDue: updateEvery === null ? null : started + updateEvery * 1000,
		};
		const doc: PlaybookDoc = {
			title: template.title,
			blocks: template.blocks.map((block) => ({ ...block, progress: freshProgress(block.progress) })),
		};
		const text = this.#store.serialize(doc, meta);
		this.#store.write({ kind: "run", run: id }, text);
		const state = this.#newDocState({ kind: "run", run: id }, doc, meta, []);
		this.#docs.set(id, state);
		this.#runOrder.push(id);
		this.#append(state, "coordinator", { type: "run_started", name });
		this.#scheduleReminder(id);
		void this.#recomputeChecks(id);
		this.#emit(null);
		return id;
	}

	#finishRun(run: RunId): Outcome<never> | null {
		if (this.#finished.has(run)) return fail("RunFinished", tr("Run has finished", "Run 已结束"));
		const doc = this.#docs.get(run);
		if (!doc?.run) return fail("UnknownRun", tr(`Run ${run} does not exist`, `Run ${run} 不存在`));
		for (const launch of this.#launches.values())
			if (launch.record.run === run && launch.record.closed === null) this.#closeLaunch(launch, "run_finished", "service");
		const meta: RunMeta = { ...doc.run, status: "finished", finishedAt: this.#now(), updateDue: null };
		doc.run = meta;
		this.#writeRunNow(doc);
		this.#scheduleReminder(run);
		this.#append(doc, "coordinator", { type: "run_finished" });
		this.#evict(doc, meta);
		this.#emit(null);
		return null;
	}

	#post(
		run: RunId | undefined,
		kind: RecordKind,
		text: string,
		block: BlockId | null,
		launch: LaunchId | null,
		next: number | null,
		quote: string | null,
		origin: "human" | "coordinator",
		session: string | null,
	): Outcome<{ readonly seq: number }> {
		const found = this.#docOf(run);
		if (!found.ok) return found;
		const doc = found.result;
		const key = keyOf(doc.ref);
		if (kind === "retrospective" && doc.run?.status !== "finished")
			return fail("BadValue", tr("A retrospective can only be posted to a finished Run", "复盘只能写在已结束的 Run 中"));
		if (next !== null && (kind !== "update" || doc.run === null))
			return fail("BadValue", tr("next is only valid for a Run update", "next 只用于 Run 的 update"));
		if (block !== null && !this.#block(doc, block)) return fail("UnknownBlock", tr(`Block ${block} does not exist`, `块 ${block} 不存在`));
		if (launch !== null) {
			const live = this.#launches.get(launch);
			const owner = live ? keyOfRun(live.record.run) : this.#finishedLaunches.get(launch);
			if (owner === undefined) return fail("UnknownLaunch", tr(`Launch ${launch} does not exist`, `Launch ${launch} 不存在`));
			if (owner !== key) return fail("BadValue", tr("Launch does not belong to this document", "Launch 不属于这个文档"));
		}
		if (kind === "update" && doc.run?.status === "running") {
			const seconds = next ?? doc.run.updateEvery;
			if (seconds !== null) this.#setDue(doc, this.#now() + seconds * 1000);
		}
		const entry = this.#append(doc, origin, {
			type: "post",
			kind,
			text,
			...(block !== null ? { block } : {}),
			...(launch !== null ? { launch } : {}),
			...(quote !== null ? { quote } : {}),
			...(session !== null ? { session } : {}),
		});
		if (kind === "result" && block !== null) {
			this.#invalidateInspections(doc, (blocks) => this.#refs.resultTargets(blocks, doc.contents).includes(block));
			void this.#recomputeChecks(key);
		}
		const finished = doc.run === null ? undefined : this.#finished.get(doc.run.id);
		if (finished && kind === "retrospective") finished.retrospective = true;
		this.#emit(doc.ref);
		return ok({ seq: entry.seq });
	}

	#snooze(run: RunId, after: number): Outcome<unknown> {
		const doc = this.#docs.get(run);
		if (!doc?.run || doc.run.updateDue === null)
			return this.#finished.has(run) || doc?.run
				? fail("BadValue", tr("There is no update due", "没有待到期的状态更新"))
				: fail("UnknownRun", tr(`Run ${run} does not exist`, `Run ${run} 不存在`));
		const due = this.#now() + after * 1000;
		this.#setDue(doc, due);
		this.#append(doc, "coordinator", { type: "update_snoozed", due });
		this.#emit(doc.ref);
		return ok({ due });
	}

	timeline(ref: DocRef, after = 0, limit?: number) {
		const doc = this.#docOf(ref.kind === "run" ? ref.run : undefined);
		return doc.ok ? ok(pageTimeline(doc.result.log.entries, after, limit)) : doc;
	}

	postHuman(ref: DocRef, kind: RecordKind, text: string, block: BlockId | null, quote: string | null = null) {
		return this.#post(ref.kind === "run" ? ref.run : undefined, kind, text, block, null, null, quote, "human", this.#conn?.session ?? null);
	}

	view(ref: DocRef): DocView {
		const found = this.#docOf(ref.kind === "template" ? undefined : ref.run);
		if (!found.ok) return { ref, title: "", run: null, blocks: [], errors: [tr("The document does not exist", "文档不存在")] };
		const doc = found.result;
		const pending = doc.log.pending;
		return {
			ref,
			title: doc.title,
			run: doc.run,
			blocks: doc.blocks.map((block) => ({ block, launchPending: pending.has(block.id) })),
			errors: doc.parseError ? [tr(`File cannot be parsed: ${doc.parseError}`, `文件不能解析：${doc.parseError}`)] : [],
		};
	}

	runs(): RunSummary[] {
		const now = this.#now();
		return this.#runOrder.flatMap((id) => {
			const doc = this.#docs.get(id);
			const finished = this.#finished.get(id);
			const summary = doc?.run ? { meta: doc.run, ...progressCounts(doc.blocks), retrospective: doc.log.retrospective } : finished;
			if (!summary) return [];
			const meta = summary.meta;
			return [
				{
					id: meta.id,
					name: meta.name,
					status: meta.status,
					started_at: meta.startedAt,
					finished_at: meta.finishedAt,
					done: summary.done,
					total: summary.total,
					update_due: meta.updateDue,
					update_overdue: meta.updateDue !== null && meta.updateDue <= now,
					retrospective: summary.retrospective,
				},
			];
		});
	}

	coordinator(): CoordinatorStatus {
		return { connected: this.#conn?.session != null, session: this.#conn?.session ?? null, pane: this.#conn?.pane ?? null };
	}

	agents(): AgentList {
		return this.#conn?.session != null ? this.#conn.agents : { kind: "offline" };
	}

	requestAgents(): void {
		const conn = this.#conn;
		if (!conn || conn.session === null) return;
		conn.agents = { kind: "pending" };
		const asked = ++this.#agentsAsked;
		conn.conn.send({ event: "agents_requested", data: {} });
		this.#emit(null);
		setTimeout(() => {
			const now = this.#conn;
			if (asked !== this.#agentsAsked || !now || now.session === null) return;
			if (now.agents.kind !== "pending" && now.agents.kind !== "unasked") return;
			now.agents = {
				kind: "unavailable",
				reason: tr(
					"The coordinator did not answer: its omp-playbooks predates this feature; restart the coordinator session and try again",
					"协调者没有回答：它加载的 omp-playbooks 早于这个功能，重启协调者会话后再试",
				),
			};
			this.#emit(null);
		}, AGENTS_WAIT_MS);
	}

	async focusCoordinator(): Promise<string | null> {
		const pane = this.#conn?.pane ?? null;
		if (pane === null) return tr("The coordinator did not provide its pane", "协调者没有给出它的 pane");
		const result = await this.#panes.focusPane(pane);
		return result.ok ? null : this.#k5Error(result.error);
	}

	#k5Error(error: string): string {
		this.#noteError(error);
		this.#emit(null);
		return error;
	}

	#noteError(error: string): void {
		this.#errors.push(error);
		if (this.#errors.length > ERRORS_KEPT) this.#errors.splice(0, this.#errors.length - ERRORS_KEPT);
	}

	errors(): readonly string[] {
		return this.#errors;
	}

	onChange(listener: (ref: DocRef | null) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void {
		const doc = this.#doc(ref);
		if (!doc) return;
		const previous = doc.render.get(block);
		doc.render.set(block, status);
		if (JSON.stringify(previous) !== JSON.stringify(status)) void this.#recomputeChecks(keyOf(ref));
	}

	#humanDoc(ref: DocRef): DocState | string {
		const doc = this.#doc(ref);
		const finished = doc ? this.#isFinished(doc) : ref.kind === "run" && this.#finished.has(ref.run);
		if (finished) return tr("Run has finished", "Run 已结束");
		return doc ?? tr("The document does not exist", "文档不存在");
	}

	#humanTarget(ref: DocRef, id: BlockId): { doc: DocState; block: Block } | string {
		const doc = this.#humanDoc(ref);
		if (typeof doc === "string") return doc;
		const block = this.#block(doc, id);
		return block ? { doc, block } : tr(`Block ${id} does not exist`, `块 ${id} 不存在`);
	}

	#takeBack(doc: DocState, id: BlockId): void {
		const lock = doc.locks.get(id);
		if (lock?.kind !== "coordinator") return;
		doc.locks.set(id, { kind: "none" });
		this.#append(doc, "human", { type: "interrupted", block: id, request: lock.request });
		this.#conn?.conn.send({ event: "interrupted", data: { ...runField(doc), block: id, request: lock.request } });
	}

	#statusProgress(block: Block, status: Status): Progress | string {
		if (block.progress.kind === "untracked")
			return tr(
				`Block ${block.id} is declared as a non-task block (task: false) and has no status`,
				`块 ${block.id} 声明为非任务块（task: false），没有状态`,
			);
		if (block.content.kind === "design" && status === "running") return tr("A design block cannot be running", "设计块不会执行中");
		return { ...block.progress, status };
	}

	edit(ref: DocRef, id: BlockId, field: HumanField, expected: string, text: string): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (!humanFieldValid(target.block.content, field))
			return target.block.content.kind === "task"
				? tr("An execution block does not have this field", "执行块没有这个字段")
				: tr("The design draft is edited by the coordinator; write a change request", "设计稿由协调者修改：请写修改要求");
		const current = fieldText(target.block, field)!;
		if (current !== expected)
			return tr(
				"The content changed while you were editing; edit the latest content again",
				"内容在你编辑时已被修改，请在最新内容上重新编辑",
			);
		if (current === text) return null;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "field", block: id, field, text });
		return null;
	}

	setTitle(ref: DocRef, expected: string, text: string): string | null {
		const doc = this.#humanDoc(ref);
		if (typeof doc === "string") return doc;
		if (doc.title !== expected)
			return tr("The title changed while you were editing; edit the latest title again", "标题在你编辑时已被修改，请在最新内容上重新编辑");
		if (doc.title === text) return null;
		doc.title = text;
		this.#scheduleWrite(doc);
		this.#emit(doc.ref);
		return null;
	}

	requestRevision(ref: DocRef, id: BlockId, prompt: string): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "design") return tr("Only design blocks accept change requests", "只有设计块接受修改要求");
		if (prompt.trim() === "") return tr("The change request is empty", "修改要求是空的");
		if (!this.#conn || this.#conn.session === null)
			return tr("The coordinator is offline; the change request was not sent", "协调者离线，修改要求没有发出");
		const doc = target.doc;
		const revision: Revision = { seq: (doc.revisions.at(-1)?.seq ?? 0) + 1, at: this.#now(), block: id, prompt };
		this.#store.appendRevision(doc.ref, revision);
		doc.revisions.push(revision);
		this.#send({ event: "revision_requested", data: { ...runField(doc), block: id, revision: revision.seq } });
		this.#emit(doc.ref);
		return null;
	}

	setStatus(ref: DocRef, id: BlockId, status: Status): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		const progress = this.#statusProgress(target.block, status);
		if (typeof progress === "string") return progress;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "progress", block: id, progress });
		this.#send({ event: "status_changed", data: { ...runField(target.doc), block: id, status } });
		return null;
	}

	setAgent(ref: DocRef, id: BlockId, agent: string | null): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "task") return tr("A design block has no execution configuration", "设计块没有执行配置");
		const name = agent?.trim() || undefined;
		if (name === target.block.content.agent) return null;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "config", block: id, config: { ...taskConfig(target.block.content), agent: name } });
		return null;
	}

	setIsolated(ref: DocRef, id: BlockId, isolated: boolean): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "task") return tr("A design block has no execution configuration", "设计块没有执行配置");
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "config", block: id, config: { ...taskConfig(target.block.content), isolated } });
		return null;
	}

	deleteBlock(ref: DocRef, id: BlockId): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "delete", block: id });
		return null;
	}

	requestLaunch(ref: DocRef, blocks: readonly BlockId[]): string | null {
		const doc = this.#humanDoc(ref);
		if (typeof doc === "string") return doc;
		if (blocks.length === 0) return tr("No blocks are selected", "没有选中的块");
		const missing = blocks.filter((id) => !this.#block(doc, id));
		if (missing.length > 0)
			return tr(`Block${missing.length === 1 ? "" : "s"} ${missing.join(", ")} not found`, `块 ${missing.join(", ")} 不存在`);
		const roots = this.#rootsError(doc, blocks);
		if (roots) return roots;
		return this.#send({ event: "launch_requested", data: { ...runField(doc), blocks: [...blocks] } })
			? null
			: tr("The coordinator is offline; the request was not sent", "协调者离线，请求没有发出");
	}

	requestStop(ref: DocRef, id: BlockId): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		const key = keyOf(target.doc.ref);
		const launches = [...this.#launches.values()]
			.filter((launch) => keyOfRun(launch.record.run) === key && launch.record.closed === null && launch.record.blocks.includes(id))
			.map((launch) => ({ id: launch.record.id, agents: launch.record.agents }));
		if (launches.length === 0) return this.setStatus(ref, id, "todo");
		return this.#send({ event: "stop_requested", data: { ...runField(target.doc), block: id, launches } })
			? null
			: tr("The coordinator is offline; the request was not sent", "协调者离线，请求没有发出");
	}

	saveImage(
		bytes: Uint8Array,
		mimeType: string,
	): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
		const extension = IMAGE_EXTENSIONS[mimeType];
		if (!extension)
			return {
				ok: false,
				error: tr(`The clipboard image format ${mimeType} cannot be displayed`, `剪贴板里的图片格式 ${mimeType} 不能显示`),
			};
		if (bytes.byteLength > MAX_IMAGE_BYTES)
			return {
				ok: false,
				error: tr(
					`The image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MiB and cannot be shown in the card`,
					`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MiB，卡片显示不了`,
				),
			};
		try {
			return { ok: true, path: this.#store.saveAsset(bytes, extension) };
		} catch (error) {
			return {
				ok: false,
				error: tr(
					`The image could not be saved: ${error instanceof Error ? error.message : String(error)}`,
					`图片没有存下：${error instanceof Error ? error.message : String(error)}`,
				),
			};
		}
	}
}

type EditChange =
	| { readonly kind: "field"; readonly block: BlockId; readonly field: BlockField; readonly text: string }
	| { readonly kind: "content"; readonly block: BlockId; readonly content: BlockContent; readonly progress: Progress }
	| { readonly kind: "progress"; readonly block: BlockId; readonly progress: Progress }
	| { readonly kind: "insert"; readonly after: BlockId | null; readonly block: Block }
	| { readonly kind: "delete"; readonly block: BlockId }
	| { readonly kind: "reorder"; readonly order: readonly BlockId[] }
	| { readonly kind: "config"; readonly block: BlockId; readonly config: TaskConfig };
