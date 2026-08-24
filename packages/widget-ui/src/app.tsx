import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientState, SuperGuideClient } from "@superguide/client-core";

export interface WidgetProps {
  client: SuperGuideClient;
  title: string;
  initiallyOpen: boolean;
  onOpenChange?: (open: boolean) => void;
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
          Yes, do it
        </button>
        <button
          type="button"
          class="confirm__deny"
          onClick={() => {
            props.onDecide("denied");
          }}
        >
          No, stop
        </button>
      </div>
    </div>
  );
}

export function Widget(props: WidgetProps): JSX.Element | null {
  const [state, setState] = useState<ClientState>(props.client.state);
  const [open, setOpen] = useState(props.initiallyOpen);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => props.client.subscribe(setState), [props.client]);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [state.messages.length, state.streamingText]);

  useEffect(() => {
    props.onOpenChange?.(open);
  }, [open, props]);

  if (state.status === "unavailable") return null;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || state.running) return;
    setDraft("");
    void props.client.send(text);
  };

  return (
    <div>
      <button
        type="button"
        class="launcher"
        aria-expanded={open}
        aria-label={open ? `Close ${props.title}` : `Open ${props.title}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? "×" : "?"}
      </button>

      {open ? (
        <section class="panel" role="dialog" aria-label={props.title}>
          <div class="panel__head">
            <h2 class="panel__title">{props.title}</h2>
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

          <div class="log" ref={logRef} role="log" aria-live="polite" aria-atomic="false">
            {state.messages.map((message) => (
              <div
                key={message.id}
                class={`bubble bubble--${message.role === "user" ? "user" : "agent"}`}
              >
                {message.content.text}
              </div>
            ))}

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

          {state.running ? (
            <p class="working" role="status">
              Working on it.
            </p>
          ) : null}

          <div class="composer">
            <label class="visually-hidden" for="sg-composer">
              What do you need?
            </label>
            <textarea
              id="sg-composer"
              value={draft}
              placeholder="What do you need?"
              onInput={(event) => {
                setDraft(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
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
