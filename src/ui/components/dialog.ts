import { h } from '../dom.js';

export interface ConfirmDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      previousFocus?.focus?.();
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };

    const cancelBtn = h('button', {
      class: 'btn',
      type: 'button',
      text: options.cancelLabel ?? '取消',
      onClick: () => finish(false),
    }) as HTMLButtonElement;

    const confirmBtn = h('button', {
      class: `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`.trim(),
      type: 'button',
      text: options.confirmLabel ?? '确认',
      onClick: () => finish(true),
    }) as HTMLButtonElement;

    const backdrop = h(
      'div',
      {
        class: 'dialog-backdrop',
        role: 'dialog',
        ariaLabel: options.title,
        onClick: (event) => {
          if (event.target === backdrop) finish(false);
        },
      },
      [
        h('div', { class: 'dialog-panel' }, [
          h('h3', { class: 'dialog-title', text: options.title }),
          h('p', { class: 'dialog-body', text: options.message }),
          h('div', { class: 'dialog-actions' }, [cancelBtn, confirmBtn]),
        ]),
      ],
    );

    window.addEventListener('keydown', onKeyDown);
    document.body.append(backdrop);
    cancelBtn.focus();
  });
}
