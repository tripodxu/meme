import type { RunConfig } from '../../core/config/types.js';
import type { PromptStyle } from '../../decision/types.js';
import { WEB_PRESETS, type WebPreset } from '../../app/presets.js';
import type { OfflinePolicyId } from '../../app/types.js';
import type { BrowserLiveOptions } from '../../app/live-policy.js';
import { signal } from './signal.js';

export class DraftStore {
  readonly selectedPresetId: ReturnType<typeof signal<string>>;
  readonly draftConfig: ReturnType<typeof signal<RunConfig>>;
  readonly draftSeed: ReturnType<typeof signal<string>>;
  readonly draftPolicy: ReturnType<typeof signal<OfflinePolicyId>>;

  /** live API Key 仅驻留内存，绝不序列化进 localStorage/IndexedDB/导出包（06 §3.2 / §8）。 */
  liveApiKey = '';
  liveModel = 'jev-1.13.0';
  livePromptStyle: PromptStyle = 'neutral';
  liveMaxCalls = 200;
  liveMaxInputTokens = 200_000;
  liveMaxMinutes = 30;
  liveScaleConfirmed = false;

  constructor() {
    const preset = WEB_PRESETS[0] as WebPreset;
    this.selectedPresetId = signal<string>(preset.id);
    this.draftConfig = signal<RunConfig>(preset.config);
    this.draftSeed = signal<string>(preset.seed);
    this.draftPolicy = signal<OfflinePolicyId>(preset.policy);
  }

  liveOptions(): BrowserLiveOptions | undefined {
    if (this.draftPolicy.get() !== 'jev_live') return undefined;
    return {
      apiKey: this.liveApiKey,
      model: this.liveModel,
      promptStyle: this.livePromptStyle,
      maxCalls: this.liveMaxCalls,
      maxInputTokens: this.liveMaxInputTokens,
      maxRunMinutes: this.liveMaxMinutes,
    };
  }
}
