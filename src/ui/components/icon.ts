const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'play'
  | 'pause'
  | 'step-forward'
  | 'fast-forward'
  | 'square'
  | 'rotate-ccw'
  | 'sun'
  | 'moon'
  | 'command'
  | 'search'
  | 'download'
  | 'upload'
  | 'copy'
  | 'check'
  | 'x'
  | 'alert-triangle'
  | 'info'
  | 'sliders'
  | 'activity'
  | 'users'
  | 'git-compare'
  | 'archive'
  | 'sparkles'
  | 'eye'
  | 'more-horizontal'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'trash'
  | 'refresh'
  | 'fork'
  | 'layers'
  | 'pin'
  | 'lock'
  | 'help-circle'
  | 'table'
  | 'sidebar';

const ICON_PATHS: Record<IconName, readonly string[]> = {
  play: ['M6 4l11 6-11 6V4z'],
  pause: ['M6 4h3v12H6z', 'M11 4h3v12h-3z'],
  'step-forward': ['M5 4l8 6-8 6V4z', 'M15 4v12'],
  'fast-forward': ['M3 4l7 6-7 6V4z', 'M10 4l7 6-7 6V4z'],
  square: ['M5 5h10v10H5z'],
  'rotate-ccw': ['M3 10a7 7 0 1 0 2-5l-2 2', 'M3 3v4h4'],
  sun: [
    'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    'M10 2v2',
    'M10 16v2',
    'M2 10h2',
    'M16 10h2',
    'M4.3 4.3l1.4 1.4',
    'M14.3 14.3l1.4 1.4',
    'M15.7 4.3l-1.4 1.4',
    'M5.7 14.3l-1.4 1.4',
  ],
  moon: ['M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z'],
  command: ['M6 6a2 2 0 1 1 2-2v12a2 2 0 1 1-2-2h8a2 2 0 1 1-2 2V4a2 2 0 1 1 2 2H6z'],
  search: ['M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M13 13l4 4'],
  download: ['M10 3v10', 'M6 9l4 4 4-4', 'M4 16h12'],
  upload: ['M10 13V3', 'M6 7l4-4 4 4', 'M4 16h12'],
  copy: ['M7 7h9v9H7z', 'M4 13V4h9'],
  check: ['M4 10.5l4 4 8-8'],
  x: ['M5 5l10 10', 'M15 5L5 15'],
  'alert-triangle': ['M10 3L2.5 16h15L10 3z', 'M10 8v4', 'M10 14.2v.3'],
  info: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M10 9v4', 'M10 6.5v.3'],
  sliders: ['M4 5h12', 'M4 10h12', 'M4 15h12', 'M7 3v4', 'M13 8v4', 'M9 13v4'],
  activity: ['M2 10h3.5l2-5 4 10 2.5-5H18'],
  users: [
    'M7.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    'M3 16a4.5 4.5 0 0 1 9 0',
    'M14 8.5a2 2 0 1 0 0-4',
    'M14.5 11.5A3.5 3.5 0 0 1 17 16',
  ],
  'git-compare': [
    'M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M15 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M5 6v8a2 2 0 0 0 2 2h3',
    'M15 14V6a2 2 0 0 0-2-2h-3',
  ],
  archive: ['M3 4h14v3H3z', 'M4 7v9h12V7', 'M8 10h4'],
  sparkles: ['M10 2l1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6L10 2z'],
  eye: ['M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z', 'M10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  'more-horizontal': ['M5 10h.5', 'M10 10h.5', 'M15 10h.5'],
  'chevron-down': ['M5 7.5l5 5 5-5'],
  'chevron-right': ['M7.5 5l5 5-5 5'],
  'chevron-left': ['M12.5 5l-5 5 5 5'],
  trash: ['M4 5h12', 'M7 5V3h6v2', 'M6 5l1 12h6l1-12'],
  refresh: ['M16 10a6 6 0 1 1-1.8-4.3L16 7.5', 'M16 3v4.5h-4.5'],
  fork: [
    'M6 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M14 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M10 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M6 5v2.5a2.5 2.5 0 0 0 2.5 2.5h3A2.5 2.5 0 0 0 14 7.5V5',
    'M10 10v5',
  ],
  layers: ['M10 3l7 4-7 4-7-4 7-4z', 'M3 10l7 4 7-4', 'M3 13.5l7 4 7-4'],
  pin: [
    'M12 3l5 5-2 2-1.5-.5-3 3 .5 2.5-1.5 1.5-3-3-3 3-1-1 3-3-3-3 1.5-1.5 2.5.5 3-3-.5-1.5 2-2z',
  ],
  lock: ['M5 9h10v8H5z', 'M7 9V6a3 3 0 0 1 6 0v3'],
  'help-circle': [
    'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
    'M8 7.5a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.4',
    'M10 14v.3',
  ],
  table: ['M3 5h14v10H3z', 'M3 9h14', 'M8 5v10'],
  sidebar: ['M3 4h14v12H3z', 'M12 4v12'],
};

export function icon(name: IconName, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ui-icon');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
