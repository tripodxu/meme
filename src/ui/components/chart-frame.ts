import { h, type Child } from '../dom.js';
import { icon } from './icon.js';

export interface ChartFrameOptions {
  readonly subtitle?: string;
  readonly windowLabel?: string;
  readonly definition?: string;
  readonly actions?: readonly Child[];
  readonly class?: string;
}

export function chartFrame(
  title: string,
  body: readonly Child[],
  options: ChartFrameOptions = {},
): HTMLElement {
  let defBox: HTMLElement | null = null;
  let defOpen = false;

  const defBtn =
    options.definition === undefined
      ? null
      : h(
          'button',
          {
            class: 'btn btn-ghost btn-sm btn-icon',
            type: 'button',
            title: '查看指标定义与口径',
            ariaLabel: `查看 ${title} 定义`,
            ariaExpanded: 'false',
            onClick: () => {
              defOpen = !defOpen;
              defBtn?.setAttribute('aria-expanded', String(defOpen));
              if (defBox !== null) defBox.hidden = !defOpen;
            },
          },
          [icon('help-circle', 13)],
        );

  if (options.definition !== undefined) {
    defBox = h('div', { class: 'chart-frame-def', hidden: true, text: options.definition });
  }

  return h('section', { class: `card ${options.class ?? ''}`.trim() }, [
    h('header', { class: 'card-header' }, [
      h('div', { class: 'card-title-group' }, [
        h('div', { class: 'actions-row' }, [
          h('h3', { class: 'card-title', text: title }),
          options.windowLabel === undefined
            ? null
            : h('span', { class: 'badge', text: options.windowLabel }),
        ]),
        options.subtitle === undefined
          ? null
          : h('p', { class: 'card-subtitle', text: options.subtitle }),
      ]),
      h('div', { class: 'card-actions' }, [...(options.actions ?? []), defBtn]),
    ]),
    h('div', { class: 'card-body' }, [...body, defBox]),
  ]);
}
