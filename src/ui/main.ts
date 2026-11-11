import { StratifyApp } from './app.js';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('缺少 #app 容器');
}

const app = new StratifyApp();
app.mount(root);

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
