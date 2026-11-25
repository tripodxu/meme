import { h } from '../dom.js';
import { icon, type IconName } from './icon.js';

export interface CommandItem {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly icon?: IconName;
  readonly run: () => void;
}

export class CommandPalette {
  private backdrop: HTMLElement | null = null;
  private activeIndex = 0;
  private filtered: readonly CommandItem[] = [];

  open(getItems: () => readonly CommandItem[]): void {
    if (this.backdrop !== null) return;
    const all = getItems();
    this.filtered = all;
    this.activeIndex = 0;

    const list = h('ul', { class: 'cmd-list', role: 'listbox', ariaLabel: '命令列表' });
    const input = h('input', {
      class: 'cmd-input',
      type: 'text',
      placeholder: '输入命令或跳转工作区…',
      ariaLabel: '搜索命令',
    }) as HTMLInputElement;

    const renderList = (): void => {
      list.replaceChildren(
        ...this.filtered.map((item, idx) => {
          const btn = h(
            'button',
            {
              class: 'cmd-item',
              type: 'button',
              role: 'option',
              ariaSelected: String(idx === this.activeIndex),
              onClick: () => {
                this.close();
                item.run();
              },
            },
            [
              h('span', { class: 'actions-row' }, [
                item.icon === undefined ? null : icon(item.icon, 14),
                h('span', { text: item.label }),
              ]),
              item.shortcut === undefined
                ? null
                : h('span', { class: 'cmd-kbd', text: item.shortcut }),
            ],
          );
          return h('li', {}, [btn]);
        }),
      );
    };

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      this.filtered =
        q === ''
          ? all
          : all.filter(
              (item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
            );
      this.activeIndex = 0;
      renderList();
    });

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (this.filtered.length > 0) {
          this.activeIndex = (this.activeIndex + 1) % this.filtered.length;
          renderList();
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (this.filtered.length > 0) {
          this.activeIndex = (this.activeIndex - 1 + this.filtered.length) % this.filtered.length;
          renderList();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = this.filtered[this.activeIndex];
        if (chosen !== undefined) {
          this.close();
          chosen.run();
        }
      }
    });

    this.backdrop = h(
      'div',
      {
        class: 'dialog-backdrop',
        role: 'dialog',
        ariaLabel: '命令面板',
        onClick: (event) => {
          if (event.target === this.backdrop) this.close();
        },
      },
      [h('div', { class: 'cmd-palette' }, [input, list])],
    );

    renderList();
    document.body.append(this.backdrop);
    input.focus();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  isOpen(): boolean {
    return this.backdrop !== null;
  }
}
