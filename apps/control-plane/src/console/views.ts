import type { DurableMessage } from "@superguide/contract/public";
import type { ProcedureRecord, TrajectoryStep } from "@superguide/contract/internal";
import type { ConversationRow } from "../repository/conversations.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function block(value: unknown): string {
  return `<pre class="json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

const STYLES = `
:root { color-scheme: light; }
body { margin: 0; font-family: system-ui, sans-serif; background: #f5f6f8; color: #16191d; }
header { padding: 14px 20px; background: #16233f; color: #fff; }
h1 { font-size: 15px; margin: 0; }
main { padding: 20px; max-width: 62rem; }
h2 { font-size: 14px; margin: 0 0 10px; }
.step { background: #fff; border: 1px solid #dde1e6; border-left-width: 4px; border-radius: 8px;
  padding: 14px; margin-bottom: 14px; }
.step--satisfied { border-left-color: #1d7a45; }
.step--unsatisfied { border-left-color: #b3261e; }
.step__head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline;
  font-size: 13px; margin-bottom: 8px; }
.tag { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: #eceff3; }
.tag--block { background: #fde8e6; color: #8c1d18; }
.tag--confirm { background: #fff3d6; color: #7a5300; }
.tag--allow { background: #e4f3ea; color: #1d5b36; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 10px; }
.json { background: #f7f8fa; border: 1px solid #e6e9ed; border-radius: 6px; padding: 8px;
  font-size: 12px; overflow-x: auto; margin: 0; }
.metrics { font-size: 12px; color: #4a5259; display: flex; gap: 14px; flex-wrap: wrap; }
.message { background: #fff; border: 1px solid #dde1e6; border-radius: 8px; padding: 10px 12px;
  margin-bottom: 8px; font-size: 13px; white-space: pre-wrap; }
.message__role { font-size: 11px; color: #6b7076; text-transform: uppercase; letter-spacing: .04em; }
table { width: 100%; border-collapse: collapse; background: #fff; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e6e9ed; }
textarea { width: 100%; min-height: 18rem; font-family: ui-monospace, monospace; font-size: 12px;
  padding: 10px; border: 1px solid #c6ccd3; border-radius: 6px; }
button { padding: 8px 12px; border-radius: 6px; border: 1px solid #16233f; background: #16233f;
  color: #fff; font: inherit; cursor: pointer; }
.summary { background: #fff; border: 1px solid #dde1e6; border-radius: 8px; padding: 12px;
  margin-bottom: 16px; font-size: 13px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — SuperGuide console</title>
<style>${STYLES}</style></head>
<body><header><h1>SuperGuide console — ${escapeHtml(title)}</h1></header><main>${body}</main></body></html>`;
}

export function renderConsoleShell(): string {
  return shell(
    "Overview",
    `<div class="summary">
      <p>Open a conversation at <code>/internal/conversations/&lt;id&gt;?productId=&lt;productId&gt;</code>
      to read its trajectory, or <code>/internal/procedures?productId=&lt;productId&gt;</code> to author a procedure.</p>
    </div>`,
  );
}

export interface TrajectoryView {
  conversation: ConversationRow;
  steps: TrajectoryStep[];
  messages: DurableMessage[];
}

export function renderTrajectory(view: TrajectoryView): string {
  const failurePoint = view.steps.find((step) => !step.expectOutcome.satisfied);

  const summary = `<div class="summary">
    <div class="metrics">
      <span>conversation ${escapeHtml(view.conversation.id)}</span>
      <span>state <strong>${escapeHtml(view.conversation.resolutionState)}</strong></span>
      <span>${String(view.steps.length)} steps</span>
      <span>${String(view.messages.length)} messages</span>
      <span>tokens in ${String(view.steps.reduce((total, step) => total + step.inputTokens, 0))}</span>
      <span>tokens out ${String(view.steps.reduce((total, step) => total + step.outputTokens, 0))}</span>
      <span>cache read ${String(view.steps.reduce((total, step) => total + step.cacheReadTokens, 0))}</span>
    </div>
    ${
      failurePoint === undefined
        ? "<p>Every step in this run was confirmed.</p>"
        : `<p><strong>Failure point:</strong> step ${String(failurePoint.seq)} — ${escapeHtml(failurePoint.expectOutcome.detail)}</p>`
    }
  </div>`;

  const steps = view.steps
    .map((step) => {
      const verdictClass =
        step.policyVerdict.decision === "block"
          ? "tag--block"
          : step.policyVerdict.decision === "confirm"
            ? "tag--confirm"
            : "tag--allow";

      return `<article class="step step--${step.expectOutcome.satisfied ? "satisfied" : "unsatisfied"}">
      <div class="step__head">
        <strong>#${String(step.seq)}</strong>
        <span class="tag">${escapeHtml(step.ladderLevel)}</span>
        <span class="tag">${escapeHtml(step.action.type)}</span>
        <span class="tag">${escapeHtml(step.action.risk)}</span>
        <span class="tag ${verdictClass}">${escapeHtml(step.policyVerdict.decision)}${
          step.policyVerdict.decision === "allow" ? "" : `: ${escapeHtml(step.policyVerdict.reason)}`
        }</span>
        <span class="tag">${step.expectOutcome.satisfied ? "confirmed" : "not confirmed"}</span>
      </div>
      <p>${escapeHtml(step.action.intent)}</p>
      <p><em>${escapeHtml(step.expectOutcome.detail)}</em> (by ${escapeHtml(step.expectOutcome.evaluatedBy)})</p>
      <div class="grid">
        <div><h2>Action</h2>${block(step.action)}</div>
        <div><h2>Result</h2>${block(step.result)}</div>
      </div>
      <div class="metrics">
        <span>model ${escapeHtml(step.model ?? "none")}</span>
        <span>in ${String(step.inputTokens)}</span>
        <span>out ${String(step.outputTokens)}</span>
        <span>cache ${String(step.cacheReadTokens)}</span>
        <span>${String(step.latencyMs)}ms</span>
        <span>request ${escapeHtml(step.requestId)}</span>
      </div>
    </article>`;
    })
    .join("\n");

  const messages = view.messages
    .map(
      (message) =>
        `<div class="message"><div class="message__role">${escapeHtml(message.role)} · #${String(message.seq)}</div>${escapeHtml(message.content.text)}</div>`,
    )
    .join("\n");

  return shell(
    "Trajectory",
    `${summary}<h2>Steps</h2>${steps.length === 0 ? "<p>No steps were recorded.</p>" : steps}
     <h2>Transcript</h2>${messages.length === 0 ? "<p>No messages.</p>" : messages}`,
  );
}

export function renderProcedureEditor(productId: string, records: ProcedureRecord[]): string {
  const rows = records
    .map(
      (record) =>
        `<tr><td>${escapeHtml(record.slug)}</td><td>${String(record.version)}</td>
         <td>${record.active ? "active" : "superseded"}</td>
         <td>${escapeHtml(record.createdBy)}</td>
         <td>${escapeHtml(record.createdAt)}</td></tr>`,
    )
    .join("\n");

  return shell(
    "Procedures",
    `<div class="summary">Product ${escapeHtml(productId)}. Publishing writes a new version and makes it the active one; the previous version is kept.</div>
     <table><thead><tr><th>Slug</th><th>Version</th><th>State</th><th>Author</th><th>Published</th></tr></thead>
     <tbody>${rows.length === 0 ? '<tr><td colspan="5">No procedures yet.</td></tr>' : rows}</tbody></table>
     <h2>Publish</h2>
     <form method="post" action="/internal/procedures?productId=${encodeURIComponent(productId)}">
       <p><label for="slug">Slug</label><br><input id="slug" name="slug" required></p>
       <p><label for="sourceYaml">Procedure</label><br><textarea id="sourceYaml" name="sourceYaml" required></textarea></p>
       <button type="submit">Validate and publish</button>
     </form>`,
  );
}
