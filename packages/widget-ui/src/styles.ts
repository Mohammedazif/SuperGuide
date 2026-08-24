export const WIDGET_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.launcher {
  position: fixed; inset-block-end: 20px; inset-inline-end: 20px;
  width: 56px; height: 56px; border-radius: 28px; border: 0;
  background: #1f3d99; color: #fff; font-size: 22px; cursor: pointer;
  box-shadow: 0 6px 20px rgb(0 0 0 / 22%); z-index: 2147483000;
}
.launcher:focus-visible { outline: 3px solid #ffd166; outline-offset: 2px; }

.panel {
  position: fixed; inset-block-end: 88px; inset-inline-end: 20px;
  width: min(380px, calc(100vw - 40px)); max-height: min(560px, calc(100vh - 120px));
  display: flex; flex-direction: column; background: #fff; color: #16191d;
  border: 1px solid #d7dbe0; border-radius: 12px; overflow: hidden;
  box-shadow: 0 16px 44px rgb(0 0 0 / 24%); z-index: 2147483000;
}
.panel__head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid #e7eaee; }
.panel__title { font-size: 14px; font-weight: 650; margin: 0; }
.panel__close { border: 0; background: transparent; font-size: 18px; cursor: pointer; color: #4a5259;
  width: 32px; height: 32px; border-radius: 6px; }
.panel__close:focus-visible { outline: 2px solid #1f3d99; outline-offset: 1px; }

.log { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.bubble { padding: 9px 11px; border-radius: 10px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
.bubble--user { align-self: flex-end; background: #1f3d99; color: #fff; max-width: 85%; }
.bubble--agent { align-self: flex-start; background: #f1f3f6; max-width: 92%; }
.bubble--streaming { color: #3c4249; }

.notice { font-size: 13px; padding: 9px 11px; border-radius: 8px; background: #fff6e5; border: 1px solid #f2d9a8; }
.escalation { font-size: 13px; padding: 9px 11px; border-radius: 8px; background: #eef4ff; border: 1px solid #c3d4f7; }
.escalation a { color: #1f3d99; }

.confirm { border: 1px solid #f2d9a8; background: #fffaf1; border-radius: 10px; padding: 11px; display: grid; gap: 9px; }
.confirm__preview { font-size: 13px; line-height: 1.45; margin: 0; }
.confirm__actions { display: flex; gap: 8px; }
.confirm__actions button { flex: 1; padding: 8px 10px; border-radius: 7px; font-size: 13px; cursor: pointer; }
.confirm__approve { border: 1px solid #1f3d99; background: #1f3d99; color: #fff; }
.confirm__deny { border: 1px solid #c6ccd3; background: #fff; color: #16191d; }
.confirm__actions button:focus-visible { outline: 3px solid #ffd166; outline-offset: 1px; }

.composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e7eaee; }
.composer textarea { flex: 1; resize: none; min-height: 40px; max-height: 120px; padding: 9px 10px;
  border: 1px solid #c6ccd3; border-radius: 8px; font-size: 14px; }
.composer textarea:focus-visible { outline: 2px solid #1f3d99; outline-offset: 0; }
.composer button { border: 0; border-radius: 8px; background: #1f3d99; color: #fff; padding: 0 14px;
  font-size: 14px; cursor: pointer; }
.composer button:disabled { background: #aab2bd; cursor: not-allowed; }

.working { font-size: 12px; color: #4a5259; padding: 0 14px 8px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;
