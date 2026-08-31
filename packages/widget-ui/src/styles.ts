export const WIDGET_STYLES = `
:host { all: initial; color-scheme: light; }
:host([data-sg-theme="dark"]) { color-scheme: dark; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

:host {
  --sg-panel: #fff;
  --sg-text: #1a1a2e;
  --sg-muted: #6b7280;
  --sg-border: #d8dbe3;
  --sg-header: #f7f8fb;
  --sg-input: #f7f8fb;
  --sg-agent: #f3f4f8;
  --sg-user: #2b3a67;
  --sg-user-text: #fff;
  --sg-accent: #2b3a67;
  --sg-error-bg: #fdecec;
  --sg-error-text: #9b1c1c;
  --sg-notice: #fff6e5;
  --sg-notice-border: #f2d9a8;
  --sg-shadow: 0 12px 40px rgba(24, 28, 45, 0.18);
}
:host([data-sg-theme="dark"]) {
  --sg-panel: #1c1c22;
  --sg-text: #ececf1;
  --sg-muted: #9a9aa8;
  --sg-border: #3f3f4a;
  --sg-header: #16161c;
  --sg-input: #2a2a33;
  --sg-agent: #2a2a33;
  --sg-user: #3d4f86;
  --sg-user-text: #fff;
  --sg-accent: #8aa4e8;
  --sg-error-bg: #3a2224;
  --sg-error-text: #f0b4b4;
  --sg-notice: #3a3220;
  --sg-notice-border: #6b5a30;
  --sg-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}

.launcher {
  position: fixed; inset-block-end: 16px; inset-inline-end: 16px;
  width: 44px; height: 44px; border-radius: 22px; border: 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: #2b3a67; color: #fff; font: 650 13px/1 system-ui, sans-serif;
  cursor: pointer; pointer-events: auto; z-index: 2147483647;
  box-shadow: var(--sg-shadow);
}
.launcher[aria-expanded="true"] { font-size: 22px; font-weight: 400; line-height: 1; }
.launcher:focus-visible { outline: 3px solid #8aa4e8; outline-offset: 2px; }
.launcher--running { box-shadow: 0 0 0 3px #3f9d63, var(--sg-shadow); }

.panel {
  position: fixed; inset-block-end: 72px; inset-inline-end: 16px;
  width: min(380px, calc(100vw - 32px)); height: min(480px, calc(100vh - 104px));
  display: flex; flex-direction: column; background: var(--sg-panel); color: var(--sg-text);
  border: 1px solid var(--sg-border); border-radius: 16px; overflow: hidden;
  box-shadow: var(--sg-shadow); z-index: 2147483647; pointer-events: auto;
  font-size: 13px; line-height: 1.45;
}
.panel__head {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; height: 48px;
  padding: 0 12px; border-bottom: 1px solid var(--sg-border); background: var(--sg-header);
}
.panel__titles { flex: 1; min-width: 0; }
.panel__title { font-size: 13px; font-weight: 650; margin: 0; line-height: 1.2; }
.panel__status { font-size: 12px; color: var(--sg-muted); margin-top: 2px; min-height: 16px; }
.panel__status--running { color: #3f9d63; }
.status-dots, .thinking { display: inline-flex; align-items: center; gap: 4px; }
.status-dots span, .thinking span {
  width: 5px; height: 5px; border-radius: 50%; background: currentColor;
  animation: sg-dot 1.1s infinite ease-in-out;
}
.thinking span { background: var(--sg-muted); width: 6px; height: 6px; }
.status-dots span:nth-child(2), .thinking span:nth-child(2) { animation-delay: 0.15s; }
.status-dots span:nth-child(3), .thinking span:nth-child(3) { animation-delay: 0.3s; }
@keyframes sg-dot {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-3px); }
}
.panel__action {
  border: 1px solid var(--sg-border); background: transparent; color: var(--sg-text);
  height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; font-weight: 650;
  cursor: pointer;
}
.panel__action[aria-pressed="true"] { background: var(--sg-input); }
.panel__action:disabled { opacity: 0.45; cursor: not-allowed; }
.panel__close {
  border: 0; background: transparent; font-size: 18px; cursor: pointer; color: var(--sg-muted);
  width: 32px; height: 32px; border-radius: 8px;
}
.panel__close:focus-visible { outline: 2px solid var(--sg-accent); }
.history {
  flex-shrink: 0; max-height: 40%; overflow-y: auto; border-bottom: 1px solid var(--sg-border);
  padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.history__item {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  border: 1px solid var(--sg-border); background: var(--sg-input); color: var(--sg-text);
  border-radius: 10px; padding: 8px 10px; cursor: pointer; font: inherit;
}
.history__item--current { border-color: var(--sg-accent); }
.history__preview { font-size: 12px; line-height: 1.35; }
.history__when { font-size: 11px; color: var(--sg-muted); }

.log {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 12px; display: flex; flex-direction: column; gap: 8px;
}
.empty {
  margin: auto; text-align: center; max-width: 260px; font-size: 12px; line-height: 1.5;
  color: var(--sg-muted);
}
.bubble {
  max-width: 86%; padding: 8px 11px; border-radius: 14px; font-size: 13px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word;
}
.bubble--user {
  align-self: flex-end; background: var(--sg-user); color: var(--sg-user-text);
  border-bottom-right-radius: 4px;
}
.bubble--agent {
  align-self: flex-start; background: var(--sg-agent); color: var(--sg-text);
  border-bottom-left-radius: 4px;
}
.bubble--streaming { font-style: italic; color: var(--sg-muted); }
.steps {
  align-self: stretch; font-size: 12px; line-height: 1.45; color: var(--sg-muted);
}
.steps summary { cursor: pointer; user-select: none; }
.steps ul { margin: 6px 0 0; padding-left: 18px; color: var(--sg-text); }
.steps__failed { color: var(--sg-error-text); }
.thinking {
  align-self: flex-start; display: flex; align-items: center; gap: 5px;
  min-width: 44px; min-height: 18px;
}

.notice, .escalation {
  align-self: stretch; font-size: 12px; padding: 9px 11px; border-radius: 10px;
  white-space: pre-wrap;
}
.notice { background: var(--sg-notice); border: 1px solid var(--sg-notice-border); color: var(--sg-text); }
.escalation { background: var(--sg-error-bg); border: 1px solid var(--sg-error-bg); color: var(--sg-error-text); }

.confirm {
  align-self: stretch; border: 1px solid var(--sg-border); background: var(--sg-header);
  border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px;
}
.confirm__preview { font-size: 13px; font-weight: 650; line-height: 1.4; margin: 0; }
.confirm__actions { display: flex; gap: 8px; }
.confirm__actions button {
  flex: 1; height: 32px; border-radius: 8px; font-size: 12px; font-weight: 650; cursor: pointer;
}
.confirm__approve { border: 1px solid var(--sg-accent); background: var(--sg-accent); color: #fff; }
.confirm__deny { border: 1px solid var(--sg-border); background: transparent; color: var(--sg-text); }

.composer {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding: 10px 12px;
  border-top: 1px solid var(--sg-border);
}
.composer textarea {
  flex: 1; resize: none; height: 36px; min-height: 36px; max-height: 96px;
  padding: 8px 14px; border: 1px solid var(--sg-border); border-radius: 18px;
  background: var(--sg-input); color: var(--sg-text); font-size: 13px; line-height: 1.3;
  outline: none;
}
.composer textarea:focus-visible { border-color: var(--sg-accent); }
.composer button {
  height: 36px; padding: 0 14px; border-radius: 18px; border: 1px solid var(--sg-border);
  background: var(--sg-accent); color: #fff; font-size: 12px; font-weight: 650; cursor: pointer;
}
.composer button:disabled { opacity: 0.45; cursor: not-allowed; }

.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;
