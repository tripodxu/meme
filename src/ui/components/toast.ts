import { h } from '../dom.js';
import { icon } from './icon.js';

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

export class ToastStack {
  readonly el: HTMLElement;
  private items: ToastItem[] = [];
  private nextId = 1;

  constructor() {
    this.el = h('div', {
      class: 'toast-stack',
      role: 'region',
      ariaLabel: '通知',
      ariaLive: 'polite',
    });
  }

  push(message: string, tone: ToastTone = 'info', durationMs = 4500): number {
    const id = this.nextId;
    this.nextId += 1;
    this.items = [...this.items.slice(-3), { id, message, tone }];
    this.render();
    if (durationMs > 0 && typeof setTimeout === 'function') {
      setTimeout(() => this.dismiss(id), durationMs);
    }
    return id;
  }

  dismiss(id: number): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.render();
  }

  private render(): void {
    this.el.replaceChildren(
      ...this.items.map((item) => {
        const closeBtn = h('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          ariaLabel: '关闭通知',
          onClick: () => this.dismiss(item.id),
        });
        closeBtn.append(icon('x', 12));
        return h('div', { class: 'toast', data: { tone: item.tone } }, [
          h('span', { text: item.message }),
          closeBtn,
        ]);
      }),
    );
  }
}
