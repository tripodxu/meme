import { signal } from '../state/signal.js';

/** 跨时序图联动的悬停 tick 游标（F4 同步十字准线总线）。 */
export const hoveredTick = signal<number | null>(null);
