const file = document.querySelector("#file");
const title = document.querySelector("#title");
const run = document.querySelector("#run");
const coordinator = document.querySelector("#coordinator");
const documentError = document.querySelector("#document-error");
const feedback = document.querySelector("#feedback");
const runSelected = document.querySelector("#run-selected");
const blocks = document.querySelector("#blocks");
const record = document.querySelector("#record");
const recordKind = document.querySelector("#kind");
const recordBlock = document.querySelector("#record-block");
const quote = document.querySelector("#quote");
const recordText = document.querySelector("#record-text");
const timeline = document.querySelector("#timeline");
const emptyLog = document.querySelector("#empty-log");
const selected = new Set();
const statuses = { todo: "To do", running: "Running", done: "Done" };
const kinds = { update: "Update", result: "Result", failure: "Failure", retrospective: "Retrospective" };
const entries = {
  run_started: "Run started", run_finished: "Run finished", block_edited: "Field edited", block_added: "Block added",
  block_deleted: "Block deleted", content_replaced: "Content replaced", blocks_reordered: "Blocks reordered",
  progress_changed: "Status changed", launch_created: "Launch started", agent_bound: "Agent attached",
  launch_closed: "Launch closed", event_sent: "Coordinator notified", interrupted: "Edit reclaimed",
  check_reported: "Check recorded", update_due: "Update due", update_snoozed: "Update snoozed",
};
let scope = "";
let data;
let after = 0;
let scopeVersion = 0;
let refreshVersion = 0;
let documentSignature = "";
let busy = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action) {
  const control = element("button", text);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

function options(control, items) {
  const signature = JSON.stringify(items);
  if (signature === control.dataset.options) return;
  const value = control.value;
  control.replaceChildren(...items.map(([id, label]) => new Option(label, id)));
  if (items.some(([id]) => id === value)) control.value = value;
  control.dataset.options = signature;
}

function showFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.hidden = message === "";
  feedback.className = isError ? "error" : "";
}

async function act(payload, message) {
  if (busy) return false;
  busy = true;
  const version = scopeVersion;
  try {
    const query = scope ? `?run=${encodeURIComponent(scope)}` : "";
    const response = await fetch(`action${query}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const reply = await response.json();
    if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
    if (version === scopeVersion) showFeedback(message);
    void refresh();
    return true;
  } catch (error) {
    if (version === scopeVersion) showFeedback(error.message, true);
    return false;
  } finally {
    busy = false;
  }
}

function editor(host, label, value, multiline, saveText, submit) {
  const form = element("form", undefined, "editor");
  const field = element("label", label);
  const input = element(multiline ? "textarea" : "input");
  if (multiline) input.rows = 6;
  else input.type = "text";
  input.value = value;
  field.append(input);
  const actions = element("div", undefined, "actions");
  const restore = () => {
    form.remove();
    documentSignature = "";
    renderDocument();
  };
  const save = element("button", saveText);
  save.type = "submit";
  actions.append(save, button("Cancel", restore));
  form.append(field, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (await submit(input.value)) restore();
  });
  host.replaceChildren(form);
  input.focus();
}

function field(host, label, value, edit) {
  const content = element("div", undefined, "field");
  const heading = element("div", label, "field-head");
  content.append(heading, element("div", value, "field-text"));
  if (edit) heading.append(button(`Edit ${label.toLowerCase()}`, () => editor(content, label, value, true, "Save", edit)));
  host.append(content);
}

function syncSelection() {
  runSelected.disabled = !data?.coordinator || selected.size === 0;
}

function renderDocument() {
  if (!data || document.querySelector(".editor")) return;
  const { view, coordinator: connected } = data;
  const signature = JSON.stringify([view, connected]);
  if (signature === documentSignature) return;
  documentSignature = signature;
  const editable = view.run?.status !== "finished" && view.errors.length === 0;
  const heading = view.title || "Playbook";
  document.title = heading;
  title.replaceChildren(element("h1", heading));
  if (editable) {
    title.append(button("Edit title", () => editor(title, "Playbook title", view.title, false, "Save", (text) =>
      act({ op: "edit", field: "documentTitle", expected: view.title, text }, "Title saved"))));
  }
  const available = new Set();
  const nodes = view.blocks.map(({ block, launchPending }) => {
    const { id, title: name, content, progress } = block;
    const tracked = progress.kind === "tracked";
    const status = tracked ? progress.status : undefined;
    const canRun = editable && connected && content.kind === "task" && tracked && status !== "running" && !launchPending;
    const card = element("article");
    const head = element("div", undefined, "block-title");
    if (canRun) {
      available.add(id);
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(id);
      checkbox.setAttribute("aria-label", `Select ${id} to run`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(id);
        else selected.delete(id);
        syncSelection();
      });
      head.append(checkbox);
    }
    const nameNode = element("h3", name || "Untitled block");
    head.append(element("span", id, "block-id"), nameNode);
    if (status) {
      const statusNode = element("span", launchPending ? `${statuses[status]} · change pending` : statuses[status], "status");
      statusNode.dataset.status = status;
      head.append(statusNode);
    }
    const edit = (key, current) => (text) => act({ op: "edit", block: id, field: key, expected: current, text }, `${id} saved`);
    if (editable) head.append(button("Edit block title", () => editor(head, `Title for ${id}`, name, false, "Save", edit("title", name))));
    card.append(head);
    if (content.kind === "task") {
      field(card, "Instructions", content.body, editable ? edit("body", content.body) : undefined);
    } else {
      field(card, "Requirement", content.requirement, editable ? edit("requirement", content.requirement) : undefined);
      field(card, "Design", content.design);
    }
    if (progress.report) field(card, "Report", progress.report);
    const actions = element("div", undefined, "actions");
    if (canRun) actions.append(button("Run block", () => act({ op: "launch", blocks: [id] }, `Execution requested for ${id}`)));
    if (editable && status === "running" && connected) actions.append(button("Stop block", () => act({ op: "stop", block: id }, `Stop requested for ${id}`)));
    if (editable && tracked && status !== "running") {
      const next = status === "done" ? "todo" : "done";
      actions.append(button(next === "todo" ? "Mark to do" : "Mark done", () => act({ op: "status", block: id, status: next }, `${id} marked ${statuses[next]}`)));
    }
    if (editable && connected && content.kind === "design") {
      actions.append(button("Request revision", () => editor(actions, `Revision for ${id}`, "", true, "Send revision", (text) =>
        act({ op: "revision", block: id, text }, `Revision sent for ${id}`))));
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  });
  for (const id of selected) if (!available.has(id)) selected.delete(id);
  syncSelection();
  blocks.replaceChildren(...(nodes.length ? nodes : [element("p", "No blocks in this document.", "meta")]));
}

function renderEntry(entry) {
  const { data, seq, at, origin } = entry;
  const item = element("li");
  item.value = seq;
  const label = data.type === "post" ? kinds[data.kind] : entries[data.type] ?? data.type;
  item.append(element("div", `${label}${data.block ? ` · ${data.block}` : ""}${data.launch ? ` · ${data.launch}` : ""}`));
  const date = new Date(at);
  item.append(element("div", `#${seq} · ${date.toLocaleString()} · ${origin}${data.quote ? ` · thread message ${data.quote}` : ""}`, "meta"));
  const text = data.type === "progress_changed" ? statuses[data.progress.status] : data.text ?? data.title ?? data.event;
  if (text) item.append(element("p", text, "entry-body"));
  return item;
}

function updateQuote() {
  recordText.disabled = quote.value !== "";
  recordText.parentElement.hidden = recordText.disabled;
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    do {
      const query = new URLSearchParams({ after: String(after) });
      if (scope) query.set("run", scope);
      const response = await fetch(`state?${query}`);
      if (version !== refreshVersion) return;
      if (!response.ok) throw new Error(response.status === 410 ? "This Playbook session ended" : `HTTP ${response.status}`);
      const state = await response.json();
      if (version !== refreshVersion) return;
      data = state;
      file.textContent = data.file;
      coordinator.textContent = data.coordinator ? "Coordinator connected" : "Coordinator offline";
      coordinator.className = data.coordinator ? "online" : "offline";
      documentError.textContent = data.view.errors.join("\n");
      documentError.hidden = data.view.errors.length === 0;
      options(run, [["", "Playbook"], ...data.runs.map((item) => [item.id, `${item.name} · ${item.done}/${item.total} · ${item.status}`])]);
      run.value = scope;
      options(recordKind, Object.entries(kinds).filter(([kind]) => kind !== "retrospective" || data.view.run?.status === "finished"));
      options(recordBlock, [["", "Whole document"], ...data.view.blocks.map(({ block }) => [block.id, `${block.id} · ${block.title}`])]);
      options(quote, [["", "Write a new record"], ...data.messages.map(({ id, label }) => [id, label])]);
      updateQuote();
      renderDocument();
      if (data.entries.length) {
        timeline.prepend(...data.entries.toReversed().map(renderEntry));
        after = data.entries.at(-1).seq;
      }
      emptyLog.hidden = after !== 0;
    } while (data.more);
  } catch (error) {
    if (version === refreshVersion) showFeedback(`Could not load the Playbook. ${error.message}`, true);
  }
}

run.addEventListener("change", () => {
  scope = run.value;
  scopeVersion++;
  after = 0;
  selected.clear();
  data = undefined;
  timeline.replaceChildren();
  title.replaceChildren(element("h1", "Playbook"));
  blocks.replaceChildren();
  documentSignature = "";
  syncSelection();
  showFeedback("");
  void refresh();
});
runSelected.addEventListener("click", () => act({ op: "launch", blocks: [...selected] }, "Execution requested for selected blocks"));
quote.addEventListener("change", updateQuote);
record.addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = scopeVersion;
  const source = quote.value ? { quote: quote.value } : { text: recordText.value };
  const target = recordBlock.value ? { block: recordBlock.value } : {};
  if (await act({ op: "post", kind: recordKind.value, ...target, ...source }, "Record added") && version === scopeVersion) {
    recordText.value = "";
    quote.value = "";
    updateQuote();
  }
});
await refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2_000);
