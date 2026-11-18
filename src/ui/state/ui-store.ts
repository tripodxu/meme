import type { PairedBatchForestSummary, WindowKey } from '../../app/view-model.js';
import type { WebRunBundle } from '../../app/types.js';
import { signal } from './signal.js';
import type { AgentSortMode } from '../workspaces/inspector.js';

export type SurfaceId = 'testbench' | 'sandbox';
export type TabId = 'setup' | 'overview' | 'inspector' | 'replay' | 'manager';
export type ThemeId = 'obsidian' | 'paper';
export type EventFilter = 'all' | 'mobility' | 'compete' | 'death';
export type AgentAliveFilter = 'all' | 'alive' | 'dead';

export class UiStore {
  readonly surface = signal<SurfaceId>('testbench');
  readonly activeTab = signal<TabId>('setup');
  readonly overviewWindow = signal<WindowKey>('all');
  readonly overviewTableMode = signal<boolean>(false);
  readonly wealthLogScale = signal<boolean>(false);
  readonly zoomRange = signal<readonly [number, number]>([0, 100]);
  readonly eventFilter = signal<EventFilter>('all');
  readonly selectedAgentId = signal<string | null>(null);
  readonly agentQuery = signal<string>('');
  readonly agentFilter = signal<AgentAliveFilter>('all');
  readonly agentClass = signal<number>(-1);
  readonly agentSort = signal<AgentSortMode>('id');
  readonly theme = signal<ThemeId>('obsidian');
  readonly speed = signal<number>(1);
  readonly notice = signal<string | null>(null);
  readonly importedBundle = signal<WebRunBundle | null>(null);
  readonly batchForestSummary = signal<PairedBatchForestSummary | null>(null);
  readonly commandPaletteOpen = signal<boolean>(false);
}
