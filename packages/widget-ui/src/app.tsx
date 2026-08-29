import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientState, SuperGuideClient } from "@superguide/client-core";

export interface WidgetProps {
  client: SuperGuideClient;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Confirmation(props: {
  preview: string;
  onDecide: (decision: "approved" | "denied") => void;
}): JSX.Element {
  const approveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    approveRef.current?.focus();
  }, []);

  return (
    <div class="confirm" role="group" aria-label="Confirm this step">
      <p class="confirm__preview">{props.preview}</p>
      <div class="confirm__actions">
        <button
          ref={approveRef}
          type="button"
          class="confirm__approve"
          onClick={() => {
            props.onDecide("approved");
          }}
        >
          Approve
        </button>
        <button
          type="button"
          class="confirm__deny"
          onClick={() => {
            props.onDecide("denied");
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export function Widget(props: WidgetProps): JSX.Element | null {
  const [state, setState] = useState<ClientState>(props.client.state);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const open = props.open;
  const setOpen = props.onOpenChange;

  useEffect(() => props.client.subscribe(setState), [props.client]);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [state.messages.length, state.streamingText, state.escalation, state.notice, state.running]);

  useEffect(() => {
    if (open) composerRef.current?.focus();
  }, [open]);

  if (state.status === "unavailable") return null;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || state.running) return;
    setDraft("");
    void props.client.send(text);
  };

  const thinking =
    state.running &&
    state.streamingText.length === 0 &&
    state.confirmation === null;
  const idle =
    !thinking &&
    state.messages.length === 0 &&
    state.streamingText.length === 0 &&
    state.confirmation === null &&
    state.escalation === null &&
    state.notice === null;

  return (
    <div>
      <button
        type="button"
        class={state.running ? "launcher launcher--running" : "launcher"}
        aria-expanded={open}
        aria-label={open ? `Close ${props.title}` : `Open ${props.title}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? "×" : "SG"}
      </button>

      {open ? (
        <section class="panel" role="region" aria-label={props.title}>
          <div class="panel__head">
            <div class="panel__titles">
              <h2 class="panel__title">{props.title}</h2>
              <div class={state.running ? "panel__status panel__status--running" : "panel__status"}>
                {state.running ? "In progress" : "Ready"}
              </div>
            </div>
            <button
              type="button"
              class="panel__action"
              onClick={() => {
                setHistoryOpen(false);
                setDraft("");
                props.client.newChat();
                composerRef.current?.focus();
              }}
            >
              New
            </button>
            <button
              type="button"
              class="panel__action"
              aria-pressed={historyOpen}
              onClick={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (next) void props.client.refreshHistory();
              }}
            >
              Chats
            </button>
            <button
              type="button"
              class="panel__close"
              aria-label="Close"
              onClick={() => {
                setOpen(false);
              }}
            >
              {"×"}
            </button>
          </div>

          {historyOpen ? (
            <div class="history" role="list">
              {state.conversations.length === 0 ? (
                <div class="empty">No earlier chats in this session.</div>
              ) : (
                state.conversations.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    class={entry.id === state.conversationId ? "history__item history__item--current" : "history__item"}
                    disabled={state.running}
                    onClick={() => {
                      setHistoryOpen(false);
                      void props.client.openConversation(entry.id);
                    }}
                  >
                    <span class="history__preview">
                      {entry.lastMessagePreview.length > 0 ? entry.lastMessagePreview : "Empty chat"}
                    </span>
                    <span class="history__when">{entry.createdAt.slice(0, 10)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}

          <div class="log" ref={logRef} role="log" aria-live="polite" aria-atomic="false">
            {idle ? (
              <div class="empty">Describe the task. SuperGuide will work through it on this page.</div>
            ) : null}

            {state.messages.map((message) => (
              <div
                key={message.id}
                class={`bubble bubble--${message.role === "user" ? "user" : "agent"}`}
              >
                {message.content.text}
              </div>
            ))}

            {state.steps.length > 0 ? (
              <details class="steps">
                <summary>
                  {state.steps.every((step) => step.ok)
                    ? `${String(state.steps.length)} completed`
                    : state.steps.every((step) => !step.ok)
                      ? `${String(state.steps.length)} failed`
                      : `${String(state.steps.filter((step) => step.ok).length)} completed, ${String(state.steps.filter((step) => !step.ok).length)} failed`}
                </summary>
                <ul>
                  {state.steps.map((step, index) => (
                    <li key={`${String(index)}-${step.label}`} class={step.ok ? undefined : "steps__failed"}>
                      {step.ok ? step.label : `${step.label} (failed)`}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {thinking ? (
              <div class="bubble bubble--agent thinking" role="status" aria-label="In progress">
                <span />
                <span />
                <span />
              </div>
            ) : null}

            {state.streamingText.length > 0 ? (
              <div class="bubble bubble--agent bubble--streaming">{state.streamingText}</div>
            ) : null}

            {state.confirmation !== null ? (
              <Confirmation
                preview={state.confirmation.preview}
                onDecide={(decision) => {
                  void props.client.decideConfirmation(decision);
                }}
              />
            ) : null}

            {state.escalation !== null ? (
              <div class="escalation" role="status">
                {state.escalation.message}
              </div>
            ) : null}

            {state.notice !== null ? (
              <div class="notice" role="status">
                {state.notice}
              </div>
            ) : null}
          </div>

          <div class="composer">
            <label class="visually-hidden" for="sg-composer">
              What are you stuck on?
            </label>
            <textarea
              id="sg-composer"
              ref={composerRef}
              value={draft}
              rows={1}
              placeholder="What are you stuck on?"
              onInput={(event) => {
                setDraft(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              onKeyUp={(event) => {
                event.stopPropagation();
              }}
            />
            <button type="button" disabled={state.running || draft.trim().length === 0} onClick={submit}>
              Send
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
