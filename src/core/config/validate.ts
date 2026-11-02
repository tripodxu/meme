import type { RunConfig, TruncatedLognormalSpec, TruncatedNormalSpec } from './types.js';
import { CONFIG_SCHEMA_VERSION, RULES_VERSION } from '../control/versions.js';
import { errorCodes, type ErrorCode } from '../control/errors.js';
import { readNumericConstant } from '../params.js';

export interface ValidationIssue {
  readonly path: string;
  readonly code: ErrorCode;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly config: RunConfig; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const SUPPORTED_RULES_VERSIONS: ReadonlySet<string> = new Set([RULES_VERSION]);
const SHARE_TOLERANCE = readNumericConstant('CONFIG_SHARE_TOLERANCE');
const RELATION_TOLERANCE = readNumericConstant('CONFIG_RELATION_TOLERANCE');
const MAX_TOP_K = readNumericConstant('MAX_TOP_K');
const MAX_COMPETITION_CANDIDATES = readNumericConstant('MAX_COMPETITION_CANDIDATES');

const POLICY_IDS: ReadonlySet<string> = new Set([
  'mock-weighted-v1',
  'random-uniform-v1',
  'jev_live',
]);

class Collector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, code: ErrorCode, message: string): void {
    this.issues.push({ path, code, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验对象结构；同时报告未知字段与缺失字段，返回是否为对象。 */
function checkObject(
  collector: Collector,
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    collector.add(path, errorCodes.CONFIG_INVALID, '必须是对象');
    return false;
  }
  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      collector.add(`${path}.${key}`, errorCodes.CONFIG_INVALID, '未知字段');
    }
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      collector.add(`${path}.${key}`, errorCodes.CONFIG_INVALID, '缺少必需字段');
    }
  }
  return true;
}

interface NumberRange {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: number;
  readonly integer?: boolean;
}

/** 校验有限数字与范围；合法时返回数字本身，便于后续跨字段比较。 */
function checkNumber(
  collector: Collector,
  value: unknown,
  path: string,
  range: NumberRange,
): number | undefined {
  if (typeof value !== 'number') {
    collector.add(path, errorCodes.CONFIG_INVALID, '必须是数字');
    return undefined;
  }
  if (!Number.isFinite(value)) {
    collector.add(path, errorCodes.CONFIG_NON_FINITE, '必须为有限数');
    return undefined;
  }
  if (range.integer && !Number.isInteger(value)) {
    collector.add(path, errorCodes.CONFIG_INVALID, '必须是整数');
    return undefined;
  }
  if (range.min !== undefined && value < range.min) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, `必须 >= ${range.min}`);
    return undefined;
  }
  if (range.max !== undefined && value > range.max) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, `必须 <= ${range.max}`);
    return undefined;
  }
  if (range.exclusiveMin !== undefined && value <= range.exclusiveMin) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, `必须 > ${range.exclusiveMin}`);
    return undefined;
  }
  return value;
}

interface NumberArrayOptions {
  readonly length: number;
  readonly nonDecreasing?: boolean;
  readonly sumToOne?: boolean;
  readonly firstElement?: number;
}

function checkNumberArray(
  collector: Collector,
  value: unknown,
  path: string,
  range: NumberRange,
  options: NumberArrayOptions,
): readonly number[] | undefined {
  if (!Array.isArray(value)) {
    collector.add(path, errorCodes.CONFIG_INVALID, '必须是数组');
    return undefined;
  }
  if (value.length !== options.length) {
    collector.add(
      path,
      errorCodes.CONFIG_INVALID,
      `长度必须为 ${options.length}，实际为 ${value.length}`,
    );
    return undefined;
  }
  let valid = true;
  value.forEach((item, index) => {
    if (checkNumber(collector, item, `${path}[${index}]`, range) === undefined) {
      valid = false;
    }
  });
  if (!valid) return undefined;

  const numbers = value as readonly number[];
  if (options.nonDecreasing) {
    for (let index = 1; index < numbers.length; index += 1) {
      const previous = numbers[index - 1] as number;
      const current = numbers[index] as number;
      if (current < previous) {
        collector.add(`${path}[${index}]`, errorCodes.CONFIG_OUT_OF_RANGE, '必须非递减');
      }
    }
  }
  if (options.sumToOne) {
    const sum = numbers.reduce((total, item) => total + item, 0);
    if (Math.abs(sum - 1) > SHARE_TOLERANCE) {
      collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, `元素之和必须为 1（实际 ${sum}）`);
    }
  }
  if (options.firstElement !== undefined && numbers[0] !== options.firstElement) {
    collector.add(
      `${path}[0]`,
      errorCodes.CONFIG_OUT_OF_RANGE,
      `首项必须为 ${options.firstElement}`,
    );
  }
  return numbers;
}

function checkLognormal(
  collector: Collector,
  value: unknown,
  path: string,
): TruncatedLognormalSpec | undefined {
  if (!checkObject(collector, value, path, ['sigma', 'median', 'min', 'max'])) return undefined;
  const before = collector.issues.length;
  checkNumber(collector, value['sigma'], `${path}.sigma`, { min: 0 });
  checkNumber(collector, value['median'], `${path}.median`, { exclusiveMin: 0 });
  checkNumber(collector, value['min'], `${path}.min`, { exclusiveMin: 0 });
  checkNumber(collector, value['max'], `${path}.max`, { exclusiveMin: 0 });
  if (collector.issues.length !== before) return undefined;
  const median = value['median'] as number;
  const min = value['min'] as number;
  const max = value['max'] as number;
  if (!(min <= median && median <= max)) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, '必须满足 0 < min <= median <= max');
    return undefined;
  }
  return value as unknown as TruncatedLognormalSpec;
}

function checkNormal(
  collector: Collector,
  value: unknown,
  path: string,
): TruncatedNormalSpec | undefined {
  if (!checkObject(collector, value, path, ['mean', 'sigma', 'min', 'max'])) return undefined;
  const before = collector.issues.length;
  checkNumber(collector, value['mean'], `${path}.mean`, { exclusiveMin: 0 });
  checkNumber(collector, value['sigma'], `${path}.sigma`, { min: 0 });
  checkNumber(collector, value['min'], `${path}.min`, { exclusiveMin: 0 });
  checkNumber(collector, value['max'], `${path}.max`, { exclusiveMin: 0 });
  if (collector.issues.length !== before) return undefined;
  const mean = value['mean'] as number;
  const min = value['min'] as number;
  const max = value['max'] as number;
  if (!(min <= mean && mean <= max)) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, '必须满足 0 < min <= mean <= max');
    return undefined;
  }
  return value as unknown as TruncatedNormalSpec;
}

function checkPairOrder(
  collector: Collector,
  lower: number | undefined,
  upper: number | undefined,
  path: string,
  message: string,
): void {
  if (lower !== undefined && upper !== undefined && lower > upper) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, message);
  }
}

/** 完整配置校验：缺字段、未知字段、NaN/Infinity、非法范围与未知版本均返回路径化错误。 */
export function validateRunConfig(input: unknown): ValidationResult {
  const collector = new Collector();

  if (
    !checkObject(collector, input, '$', [
      'schemaVersion',
      'rulesVersion',
      'population',
      'opportunity',
      'lifespan',
      'attributes',
      'effort',
      'need',
      'descent',
      'ascent',
      'competition',
      'network',
      'networkOpportunity',
      'dynamics',
      'openness',
      'decision',
      'schedule',
      'metrics',
    ])
  ) {
    return { ok: false, issues: collector.issues };
  }

  const root = input;

  if (root['schemaVersion'] !== CONFIG_SCHEMA_VERSION) {
    collector.add('$.schemaVersion', errorCodes.CONFIG_UNKNOWN_VERSION, '不支持该 schemaVersion');
  }
  if (
    typeof root['rulesVersion'] !== 'string' ||
    !SUPPORTED_RULES_VERSIONS.has(root['rulesVersion'])
  ) {
    collector.add('$.rulesVersion', errorCodes.CONFIG_UNKNOWN_VERSION, '不支持该 rulesVersion');
  }

  const population = root['population'];
  let classCount: number | undefined;
  let hardLifeFactor: number | undefined;
  let hardLifeFloor: number | undefined;
  let hardMin: number | undefined;
  if (
    checkObject(collector, population, '$.population', [
      'initialPopulation',
      'classCount',
      'classShares',
      'initialValue',
      'initialAgeMode',
    ])
  ) {
    checkNumber(collector, population['initialPopulation'], '$.population.initialPopulation', {
      min: 2,
      max: 10000,
      integer: true,
    });
    classCount = checkNumber(collector, population['classCount'], '$.population.classCount', {
      min: 2,
      max: 8,
      integer: true,
    });
    checkNumber(collector, population['initialValue'], '$.population.initialValue', { min: 0 });
    const mode = population['initialAgeMode'];
    if (mode !== 'uniform' && mode !== 'newborn') {
      collector.add(
        '$.population.initialAgeMode',
        errorCodes.CONFIG_INVALID,
        '必须为 uniform 或 newborn',
      );
    }
    if (classCount !== undefined) {
      checkNumberArray(
        collector,
        population['classShares'],
        '$.population.classShares',
        { min: 0, max: 1 },
        { length: classCount, sumToOne: true },
      );
    }
  }

  if (checkObject(collector, root['opportunity'], '$.opportunity', ['dailyBase', 'env0'])) {
    const opportunity = root['opportunity'];
    checkNumber(collector, opportunity['dailyBase'], '$.opportunity.dailyBase', {
      exclusiveMin: 0,
    });
    if (classCount !== undefined) {
      checkNumberArray(
        collector,
        opportunity['env0'],
        '$.opportunity.env0',
        { exclusiveMin: 0 },
        { length: classCount },
      );
    }
  }

  if (
    checkObject(collector, root['lifespan'], '$.lifespan', [
      'decay',
      'initialLife',
      'hardLifeFactor',
      'hardLifeFloor',
    ])
  ) {
    const lifespan = root['lifespan'];
    if (classCount !== undefined) {
      checkNumberArray(
        collector,
        lifespan['decay'],
        '$.lifespan.decay',
        { min: 0, max: 3 },
        { length: classCount },
      );
    }
    checkNormal(collector, lifespan['initialLife'], '$.lifespan.initialLife');
    hardLifeFactor = checkNumber(
      collector,
      lifespan['hardLifeFactor'],
      '$.lifespan.hardLifeFactor',
      {
        min: 0,
      },
    );
    hardLifeFloor = checkNumber(collector, lifespan['hardLifeFloor'], '$.lifespan.hardLifeFloor', {
      exclusiveMin: 0,
      max: 1,
    });
  }

  if (checkObject(collector, root['attributes'], '$.attributes', ['ge', 'hard'])) {
    const attributes = root['attributes'];
    checkLognormal(collector, attributes['ge'], '$.attributes.ge');
    hardMin = checkLognormal(collector, attributes['hard'], '$.attributes.hard')?.min;
  }

  // `hardLifeFloor` 只有在对合法 hard 域取最小因子时仍不低于它，才是纯数值护栏。
  // 否则它会改变寿命损耗，必须拒绝配置而不是在注册表里谎称 guardOnly。
  if (hardLifeFactor !== undefined && hardLifeFloor !== undefined && hardMin !== undefined) {
    const minFactor = 1 + hardLifeFactor * (hardMin - 1);
    if (hardLifeFloor > minFactor + RELATION_TOLERANCE) {
      collector.add(
        '$.lifespan.hardLifeFloor',
        errorCodes.CONFIG_OUT_OF_RANGE,
        `必须 <= 1 + hardLifeFactor×(attributes.hard.min-1)（当前上界 ${minFactor}），否则会在合法 hard 域内改变寿命损耗`,
      );
    }
  }

  if (checkObject(collector, root['effort'], '$.effort', ['shape'])) {
    checkNumber(collector, root['effort']['shape'], '$.effort.shape', { exclusiveMin: 0 });
  }

  if (
    checkObject(collector, root['need'], '$.need', [
      'threshold',
      'belowNeedLimit',
      'bufferDays',
      'needMultiplier',
    ])
  ) {
    const need = root['need'];
    checkNumber(collector, need['threshold'], '$.need.threshold', { min: 0, max: 1 });
    checkNumber(collector, need['belowNeedLimit'], '$.need.belowNeedLimit', {
      min: 1,
      integer: true,
    });
    checkNumber(collector, need['bufferDays'], '$.need.bufferDays', { min: 2, integer: true });
    if (classCount !== undefined) {
      checkNumberArray(
        collector,
        need['needMultiplier'],
        '$.need.needMultiplier',
        { min: 1, max: 6 },
        { length: classCount, nonDecreasing: true, firstElement: 1 },
      );
    }
  }

  if (checkObject(collector, root['descent'], '$.descent', ['days'])) {
    checkNumber(collector, root['descent']['days'], '$.descent.days', { exclusiveMin: 0 });
  }

  if (checkObject(collector, root['ascent'], '$.ascent', ['crossDays', 'returnDiscount'])) {
    const ascent = root['ascent'];
    if (classCount !== undefined) {
      checkNumberArray(
        collector,
        ascent['crossDays'],
        '$.ascent.crossDays',
        { exclusiveMin: 0 },
        { length: classCount - 1 },
      );
    }
    checkNumberArray(
      collector,
      ascent['returnDiscount'],
      '$.ascent.returnDiscount',
      { min: 0, max: 1 },
      { length: 3, nonDecreasing: true },
    );
  }

  if (
    checkObject(collector, root['competition'], '$.competition', [
      'powerValueExponent',
      'powerGeExponent',
      'powerHardExponent',
      'crossClassInitiatorMultiplier',
      'crossClassTargetMultiplier',
      'lossRate',
      'baseTransferEfficiency',
      'highToLowWinMultiplier',
      'lowToHighWinMultiplier',
      'candidateCount',
      'localTargetProbability',
    ])
  ) {
    const competition = root['competition'];
    checkNumber(collector, competition['powerValueExponent'], '$.competition.powerValueExponent', {
      min: 0,
    });
    checkNumber(collector, competition['powerGeExponent'], '$.competition.powerGeExponent', {
      min: 0,
    });
    checkNumber(collector, competition['powerHardExponent'], '$.competition.powerHardExponent', {
      min: 0,
    });
    checkNumber(
      collector,
      competition['crossClassInitiatorMultiplier'],
      '$.competition.crossClassInitiatorMultiplier',
      { min: 0, max: 1.25 },
    );
    checkNumber(
      collector,
      competition['crossClassTargetMultiplier'],
      '$.competition.crossClassTargetMultiplier',
      { min: 0, max: 1.25 },
    );
    checkNumber(collector, competition['lossRate'], '$.competition.lossRate', { min: 0, max: 0.5 });
    const efficiency = checkNumber(
      collector,
      competition['baseTransferEfficiency'],
      '$.competition.baseTransferEfficiency',
      { min: 0, max: 1.25 },
    );
    if (efficiency !== undefined && efficiency > 1) {
      collector.add(
        '$.competition.baseTransferEfficiency',
        errorCodes.CONFIG_OUT_OF_RANGE,
        '必须 <= 1（同层与防守方方向乘子恒为 1，否则胜者收益会超过败者损失）',
      );
    }
    const highToLow = checkNumber(
      collector,
      competition['highToLowWinMultiplier'],
      '$.competition.highToLowWinMultiplier',
      { min: 0, max: 1.25 },
    );
    const lowToHigh = checkNumber(
      collector,
      competition['lowToHighWinMultiplier'],
      '$.competition.lowToHighWinMultiplier',
      { min: 0, max: 1.25 },
    );
    checkNumber(collector, competition['candidateCount'], '$.competition.candidateCount', {
      min: 0,
      max: MAX_COMPETITION_CANDIDATES,
      integer: true,
    });
    checkNumber(
      collector,
      competition['localTargetProbability'],
      '$.competition.localTargetProbability',
      { min: 0, max: 1 },
    );

    if (efficiency !== undefined) {
      for (const [key, multiplier] of [
        ['highToLowWinMultiplier', highToLow],
        ['lowToHighWinMultiplier', lowToHigh],
      ] as const) {
        if (multiplier !== undefined && efficiency * multiplier > 1) {
          collector.add(
            `$.competition.${key}`,
            errorCodes.CONFIG_OUT_OF_RANGE,
            'baseTransferEfficiency × 方向乘子必须 <= 1',
          );
        }
      }
    }
  }

  if (
    checkObject(collector, root['network'], '$.network', [
      'maxDegree',
      'initialDegree',
      'rewireProb',
      'classWeight',
      'valueWeight',
    ])
  ) {
    const network = root['network'];
    const maxDegree = checkNumber(collector, network['maxDegree'], '$.network.maxDegree', {
      min: 0,
      max: 6,
      integer: true,
    });
    const initialDegree = checkNumber(
      collector,
      network['initialDegree'],
      '$.network.initialDegree',
      { min: 0, max: 6, integer: true },
    );
    checkPairOrder(
      collector,
      initialDegree,
      maxDegree,
      '$.network.initialDegree',
      'initialDegree 必须 <= maxDegree',
    );
    checkNumber(collector, network['rewireProb'], '$.network.rewireProb', { min: 0, max: 1 });
    checkNumber(collector, network['classWeight'], '$.network.classWeight', { min: 0 });
    checkNumber(collector, network['valueWeight'], '$.network.valueWeight', { min: 0 });
  }

  if (
    checkObject(collector, root['networkOpportunity'], '$.networkOpportunity', [
      'beta',
      'min',
      'max',
    ])
  ) {
    const opportunity = root['networkOpportunity'];
    checkNumber(collector, opportunity['beta'], '$.networkOpportunity.beta', { min: 0 });
    const min = checkNumber(collector, opportunity['min'], '$.networkOpportunity.min', {
      exclusiveMin: 0,
    });
    const max = checkNumber(collector, opportunity['max'], '$.networkOpportunity.max', {
      exclusiveMin: 0,
    });
    checkPairOrder(collector, min, max, '$.networkOpportunity.min', 'min 必须 <= max');
  }

  if (
    checkObject(collector, root['dynamics'], '$.dynamics', [
      'classSmoothing',
      'congestionExponent',
      'polarizationExponent',
      'giniReference',
      'congestionMin',
      'congestionMax',
      'emptyClassPopulationFloor',
      'polarizationMin',
      'polarizationMax',
    ])
  ) {
    const dynamics = root['dynamics'];
    checkNumber(collector, dynamics['classSmoothing'], '$.dynamics.classSmoothing', {
      exclusiveMin: 0,
      max: 1,
    });
    checkNumber(collector, dynamics['congestionExponent'], '$.dynamics.congestionExponent', {
      min: 0,
    });
    checkNumber(collector, dynamics['polarizationExponent'], '$.dynamics.polarizationExponent', {
      min: 0,
    });
    checkNumber(collector, dynamics['giniReference'], '$.dynamics.giniReference', {
      min: 0,
      max: 1,
    });
    const congestionMin = checkNumber(
      collector,
      dynamics['congestionMin'],
      '$.dynamics.congestionMin',
      { exclusiveMin: 0 },
    );
    const congestionMax = checkNumber(
      collector,
      dynamics['congestionMax'],
      '$.dynamics.congestionMax',
      { exclusiveMin: 0 },
    );
    checkPairOrder(
      collector,
      congestionMin,
      congestionMax,
      '$.dynamics.congestionMin',
      'congestionMin 必须 <= congestionMax',
    );
    checkNumber(
      collector,
      dynamics['emptyClassPopulationFloor'],
      '$.dynamics.emptyClassPopulationFloor',
      { exclusiveMin: 0, max: 1 },
    );
    const polarizationMin = checkNumber(
      collector,
      dynamics['polarizationMin'],
      '$.dynamics.polarizationMin',
      { exclusiveMin: 0 },
    );
    const polarizationMax = checkNumber(
      collector,
      dynamics['polarizationMax'],
      '$.dynamics.polarizationMax',
      { exclusiveMin: 0 },
    );
    checkPairOrder(
      collector,
      polarizationMin,
      polarizationMax,
      '$.dynamics.polarizationMin',
      'polarizationMin 必须 <= polarizationMax',
    );
  }

  if (
    checkObject(collector, root['openness'], '$.openness', [
      'initial',
      'timeConstantDays',
      'intercept',
      'mobilityWeight',
      'mobilityReference',
      'giniWeight',
      'segregationWeight',
      'segregationReference',
      'ascentCostWeight',
      'multiplierMin',
      'multiplierMax',
    ])
  ) {
    const openness = root['openness'];
    checkNumber(collector, openness['initial'], '$.openness.initial', { min: 0, max: 1 });
    checkNumber(collector, openness['timeConstantDays'], '$.openness.timeConstantDays', {
      exclusiveMin: 0,
    });
    checkNumber(collector, openness['intercept'], '$.openness.intercept', { min: -20, max: 20 });
    checkNumber(collector, openness['mobilityWeight'], '$.openness.mobilityWeight', { min: 0 });
    checkNumber(collector, openness['mobilityReference'], '$.openness.mobilityReference', {
      min: 0,
      max: 1,
    });
    checkNumber(collector, openness['giniWeight'], '$.openness.giniWeight', { min: 0 });
    checkNumber(collector, openness['segregationWeight'], '$.openness.segregationWeight', {
      min: 0,
    });
    checkNumber(collector, openness['segregationReference'], '$.openness.segregationReference', {
      min: -1,
      max: 1,
    });
    checkNumber(collector, openness['ascentCostWeight'], '$.openness.ascentCostWeight', { min: 0 });
    const min = checkNumber(collector, openness['multiplierMin'], '$.openness.multiplierMin', {
      exclusiveMin: 0,
    });
    const max = checkNumber(collector, openness['multiplierMax'], '$.openness.multiplierMax', {
      exclusiveMin: 0,
    });
    checkPairOrder(
      collector,
      min,
      max,
      '$.openness.multiplierMin',
      'multiplierMin 必须 <= multiplierMax',
    );
  }

  if (checkObject(collector, root['decision'], '$.decision', ['interval', 'topK', 'policy'])) {
    const decision = root['decision'];
    checkNumber(collector, decision['interval'], '$.decision.interval', { min: 1, integer: true });
    checkNumber(collector, decision['topK'], '$.decision.topK', {
      min: 1,
      max: MAX_TOP_K,
      integer: true,
    });
    if (typeof decision['policy'] !== 'string' || !POLICY_IDS.has(decision['policy'])) {
      collector.add('$.decision.policy', errorCodes.CONFIG_INVALID, '未知策略标识');
    }
  }

  if (
    checkObject(collector, root['schedule'], '$.schedule', [
      'totalTicks',
      'statsStride',
      'snapshotStride',
    ])
  ) {
    const schedule = root['schedule'];
    const totalTicks = checkNumber(collector, schedule['totalTicks'], '$.schedule.totalTicks', {
      min: 1,
      integer: true,
    });
    const statsStride = checkNumber(collector, schedule['statsStride'], '$.schedule.statsStride', {
      min: 1,
      integer: true,
    });
    checkNumber(collector, schedule['snapshotStride'], '$.schedule.snapshotStride', {
      min: 1,
      integer: true,
    });
    checkPairOrder(
      collector,
      statsStride,
      totalTicks,
      '$.schedule.statsStride',
      'statsStride 必须 <= totalTicks',
    );
  }

  if (
    checkObject(collector, root['metrics'], '$.metrics', [
      'flowWindowDays',
      'mobilityWindowDays',
      'topWealthShareFraction',
    ])
  ) {
    const metrics = root['metrics'];
    checkNumber(collector, metrics['flowWindowDays'], '$.metrics.flowWindowDays', {
      min: 1,
      integer: true,
    });
    checkNumber(collector, metrics['mobilityWindowDays'], '$.metrics.mobilityWindowDays', {
      min: 1,
      integer: true,
    });
    checkNumber(collector, metrics['topWealthShareFraction'], '$.metrics.topWealthShareFraction', {
      exclusiveMin: 0,
      max: 1,
    });
  }

  if (!collector.ok) {
    return { ok: false, issues: collector.issues };
  }
  return { ok: true, config: input as unknown as RunConfig, issues: [] };
}

export function isValidRunConfig(input: unknown): input is RunConfig {
  return validateRunConfig(input).ok;
}
