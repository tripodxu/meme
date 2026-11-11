export type Child = Node | string | number | null | undefined | false;

export interface ElementAttributes {
  readonly class?: string;
  readonly id?: string;
  readonly title?: string;
  readonly text?: string;
  readonly role?: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly hidden?: boolean;
  readonly href?: string;
  readonly download?: string;
  readonly accept?: string;
  readonly min?: string | number;
  readonly max?: string | number;
  readonly step?: string | number;
  readonly name?: string;
  readonly for?: string;
  readonly ariaLabel?: string;
  readonly ariaLive?: string;
  readonly ariaSelected?: string;
  readonly ariaPressed?: string;
  readonly ariaCurrent?: string;
  readonly tabIndex?: number;
  readonly style?: string;
  readonly data?: Record<string, string>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onChange?: (event: Event) => void;
  readonly onInput?: (event: Event) => void;
  readonly onSubmit?: (event: SubmitEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: ElementAttributes = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attributes.class !== undefined) element.className = attributes.class;
  if (attributes.id !== undefined) element.id = attributes.id;
  if (attributes.title !== undefined) element.title = attributes.title;
  if (attributes.role !== undefined) element.setAttribute('role', attributes.role);
  if (attributes.ariaLabel !== undefined) element.setAttribute('aria-label', attributes.ariaLabel);
  if (attributes.ariaLive !== undefined) element.setAttribute('aria-live', attributes.ariaLive);
  if (attributes.ariaSelected !== undefined) {
    element.setAttribute('aria-selected', attributes.ariaSelected);
  }
  if (attributes.ariaPressed !== undefined) {
    element.setAttribute('aria-pressed', attributes.ariaPressed);
  }
  if (attributes.ariaCurrent !== undefined) {
    element.setAttribute('aria-current', attributes.ariaCurrent);
  }
  if (attributes.tabIndex !== undefined) element.tabIndex = attributes.tabIndex;
  if (attributes.style !== undefined) element.setAttribute('style', attributes.style);
  if (attributes.hidden === true) element.hidden = true;
  for (const [key, value] of Object.entries(attributes.data ?? {})) {
    element.dataset[key] = value;
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const input = element as unknown as HTMLInputElement;
    if (attributes.type !== undefined) input.type = attributes.type;
    if (attributes.value !== undefined) input.value = attributes.value;
    if (attributes.placeholder !== undefined) input.placeholder = attributes.placeholder;
    if (attributes.disabled !== undefined) input.disabled = attributes.disabled;
    if (attributes.checked !== undefined) input.checked = attributes.checked;
    if (attributes.name !== undefined) input.name = attributes.name;
    if (attributes.accept !== undefined) input.accept = attributes.accept;
    if (attributes.min !== undefined) input.min = String(attributes.min);
    if (attributes.max !== undefined) input.max = String(attributes.max);
    if (attributes.step !== undefined) input.step = String(attributes.step);
    if (attributes.onInput !== undefined) input.addEventListener('input', attributes.onInput);
    if (attributes.onChange !== undefined) input.addEventListener('change', attributes.onChange);
  }
  if (tag === 'button' && attributes.disabled !== undefined) {
    (element as HTMLButtonElement).disabled = attributes.disabled;
  }
  if (tag === 'option') {
    const option = element as unknown as HTMLOptionElement;
    if (attributes.value !== undefined) option.value = attributes.value;
    if (attributes.selected !== undefined) option.selected = attributes.selected;
  }
  if (tag === 'a') {
    const anchor = element as unknown as HTMLAnchorElement;
    if (attributes.href !== undefined) anchor.href = attributes.href;
    if (attributes.download !== undefined) anchor.download = attributes.download;
  }
  if (tag === 'label' && attributes.for !== undefined) {
    (element as HTMLLabelElement).htmlFor = attributes.for;
  }
  if (attributes.text !== undefined) element.textContent = attributes.text;
  if (attributes.onClick !== undefined) {
    element.addEventListener('click', attributes.onClick as EventListener);
  }
  if (attributes.onSubmit !== undefined) {
    element.addEventListener('submit', attributes.onSubmit as EventListener);
  }
  append(element, children);
  return element;
}

export function append(parent: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
}

export function clear(element: Element): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `field-${Math.abs(hashString(label))}`;
  if (control.id === '') control.id = id;
  return h('div', { class: 'field' }, [
    h('label', { for: id, class: 'field-label', text: label }),
    control,
    hint === undefined ? null : h('p', { class: 'field-hint', text: hint }),
  ]);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

export function badge(
  text: string,
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' = 'muted',
): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, text });
}

export function card(
  title: string,
  body: readonly Child[],
  options: { subtitle?: string; actions?: readonly Child[]; class?: string } = {},
): HTMLElement {
  return h('section', { class: `card ${options.class ?? ''}` }, [
    h('header', { class: 'card-header' }, [
      h('div', {}, [
        h('h3', { class: 'card-title', text: title }),
        options.subtitle === undefined
          ? null
          : h('p', { class: 'card-subtitle', text: options.subtitle }),
      ]),
      options.actions === undefined ? null : h('div', { class: 'card-actions' }, options.actions),
    ]),
    h('div', { class: 'card-body' }, body),
  ]);
}

export function table(
  headers: readonly string[],
  rows: readonly (readonly Child[])[],
): HTMLElement {
  return h('div', { class: 'table-wrap' }, [
    h('table', { class: 'data-table' }, [
      h('thead', {}, [
        h(
          'tr',
          {},
          headers.map((header) => h('th', { text: header })),
        ),
      ]),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {},
            row.map((cell) => h('td', {}, [cell])),
          ),
        ),
      ),
    ]),
  ]);
}
