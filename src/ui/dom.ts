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
  readonly open?: boolean;
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
  readonly ariaExpanded?: string;
  readonly ariaInvalid?: string;
  readonly tabIndex?: number;
  readonly style?: string;
  readonly data?: Record<string, string>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onDblClick?: (event: MouseEvent) => void;
  readonly onChange?: (event: Event) => void;
  readonly onInput?: (event: Event) => void;
  readonly onSubmit?: (event: SubmitEvent) => void;
  readonly onScroll?: (event: Event) => void;
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
  if (attributes.ariaExpanded !== undefined) {
    element.setAttribute('aria-expanded', attributes.ariaExpanded);
  }
  if (attributes.ariaInvalid !== undefined) {
    element.setAttribute('aria-invalid', attributes.ariaInvalid);
  }
  if (attributes.tabIndex !== undefined) element.tabIndex = attributes.tabIndex;
  if (attributes.style !== undefined) element.setAttribute('style', attributes.style);
  if (attributes.hidden === true) element.hidden = true;
  if (tag === 'details' && attributes.open === true) {
    (element as HTMLDetailsElement).open = true;
  }
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
  if (attributes.onDblClick !== undefined) {
    element.addEventListener('dblclick', attributes.onDblClick as EventListener);
  }
  if (attributes.onSubmit !== undefined) {
    element.addEventListener('submit', attributes.onSubmit as EventListener);
  }
  if (attributes.onScroll !== undefined) {
    element.addEventListener('scroll', attributes.onScroll as EventListener, { passive: true });
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
  element.replaceChildren();
}

export function setTextIfChanged(element: Element | null, next: string): void {
  if (element !== null && element.textContent !== next) {
    element.textContent = next;
  }
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

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info' | 'violet';

export function badge(text: string, tone: BadgeTone = 'muted'): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, text });
}

export function card(
  title: string,
  body: readonly Child[],
  options: { subtitle?: string; actions?: readonly Child[]; class?: string; id?: string } = {},
): HTMLElement {
  const sectionAttrs: ElementAttributes =
    options.id === undefined
      ? { class: `card ${options.class ?? ''}`.trim() }
      : { class: `card ${options.class ?? ''}`.trim(), id: options.id };
  return h('section', sectionAttrs, [
    h('header', { class: 'card-header' }, [
      h('div', { class: 'card-title-group' }, [
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
  options: { maxHeight?: number } = {},
): HTMLElement {
  const wrapAttrs: ElementAttributes =
    options.maxHeight === undefined
      ? { class: 'table-wrap' }
      : { class: 'table-wrap', style: `max-height:${options.maxHeight}px` };
  return h('div', wrapAttrs, [
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

export const CLASS_SYMBOLS = ['○', '△', '□', '◇', '☆'] as const;
export const CLASS_NAMES = ['底层', '劳工层', '中坚层', '精英层', '顶层'] as const;

export function classSymbol(classIndex: number): string {
  return CLASS_SYMBOLS[classIndex] ?? '•';
}

export function classTitle(classIndex: number): string {
  const name = CLASS_NAMES[classIndex];
  return name === undefined ? `Class ${classIndex}` : `C${classIndex} ${name}`;
}
