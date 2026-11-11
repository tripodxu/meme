import { StratifyApp } from './app.js';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('缺少 #app 容器');
}

const app = new StratifyApp();
app.mount(root);

const TAB_KEYS: Record<string, 'setup' | 'overview' | 'inspector' | 'replay' | 'manager'> = {
  '1': 'setup',
  '2': 'overview',
  '3': 'inspector',
  '4': 'replay',
  '5': 'manager',
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'select' || tag === 'textarea' || target.isContentEditable;
}

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target)) return;
  const tab = TAB_KEYS[event.key];
  if (tab !== undefined) {
    event.preventDefault();
    app.setTab(tab);
    return;
  }
  if (event.key === ' ') {
    event.preventDefault();
    const status = app.getSnapshot().status;
    if (status === 'running' || status === 'awaiting_decision' || status === 'replaying') {
      app.controller.pause();
    } else if (status === 'paused') {
      if (app.getSnapshot().replay !== null) app.controller.startReplay();
      else app.controller.start();
    } else if (status === 'ready') {
      app.controller.start();
    } else {
      app.start();
    }
    return;
  }
  if (event.key.toLowerCase() === 'n') {
    event.preventDefault();
    app.step();
    return;
  }
  if (event.key.toLowerCase() === 'e') {
    event.preventDefault();
    app.downloadBundle();
  }
});

window.addEventListener('error', (event) => {
  app.notify(`界面错误：${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  app.notify(`未处理的异步错误：${reason}`);
});

// 供浏览器 E2E 与手动诊断使用；不暴露任何密钥。
Object.defineProperty(window, '__stratify', {
  value: {
    app,
    snapshot: () => app.getSnapshot(),
    exportBundle: () => app.controller.exportBundle(true),
  },
  enumerable: false,
});
