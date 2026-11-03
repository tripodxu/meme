import type { RunConfig, TruncatedLognormalSpec, TruncatedNormalSpec } from './types.js';
import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_SCHEMA_VERSION_V1,
  CONFIG_SCHEMA_VERSION_V2,
  RULES_VERSION,
} from '../control/versions.js';
import { errorCodes, type ErrorCode } from '../control/errors.js';
import { getParamDefinition, readNumericConstant } from '../params.js';
import type { ArrayDomain, ParamDefinition, ParamDomain } from '../params.js';

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

type NumericDomain = Extract<ParamDomain, { kind: 'number' }>;

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
  readonly exclusiveMax?: number;
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
  if (range.exclusiveMax !== undefined && value >= range.exclusiveMax) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, `必须 < ${range.exclusiveMax}`);
    return undefined;
  }
  return value;
}

interface NumberArrayOptions {
  readonly length: number;
  readonly nonDecreasing?: boolean | undefined;
  readonly sumToOne?: boolean | undefined;
  readonly firstElement?: number | undefined;
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
  namePrefix: string,
): TruncatedLognormalSpec | undefined {
  if (!checkObject(collector, value, path, ['sigma', 'median', 'min', 'max'])) return undefined;
  const before = collector.issues.length;
  checkRegisteredNumber(collector, value['sigma'], `${path}.sigma`, `${namePrefix}.sigma`);
  checkRegisteredNumber(collector, value['median'], `${path}.median`, `${namePrefix}.median`);
  checkRegisteredNumber(collector, value['min'], `${path}.min`, `${namePrefix}.min`);
  checkRegisteredNumber(collector, value['max'], `${path}.max`, `${namePrefix}.max`);
  if (collector.issues.length !== before) return undefined;
  const median = value['median'] as number;
  const min = value['min'] as number;
  const max = value['max'] as number;
  if (!(min <= median && median <= max)) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, '必须满足 0 < min <= median <= max');
    return undefined;
  }
  const sigma = value['sigma'] as number;
  const maxSigma = Math.log(max) - Math.log(min);
  if (sigma > maxSigma + RELATION_TOLERANCE) {
    collector.add(
      `${path}.sigma`,
      errorCodes.CONFIG_OUT_OF_RANGE,
      `必须 <= ln(max/min)（当前上界 ${maxSigma}），否则截断拒绝采样可能不收敛`,
    );
    return undefined;
  }
  return value as unknown as TruncatedLognormalSpec;
}

function checkNormal(
  collector: Collector,
  value: unknown,
  path: string,
  namePrefix: string,
): TruncatedNormalSpec | undefined {
  if (!checkObject(collector, value, path, ['mean', 'sigma', 'min', 'max'])) return undefined;
  const before = collector.issues.length;
  checkRegisteredNumber(collector, value['mean'], `${path}.mean`, `${namePrefix}.mean`);
  checkRegisteredNumber(collector, value['sigma'], `${path}.sigma`, `${namePrefix}.sigma`);
  checkRegisteredNumber(collector, value['min'], `${path}.min`, `${namePrefix}.min`);
  checkRegisteredNumber(collector, value['max'], `${path}.max`, `${namePrefix}.max`);
  if (collector.issues.length !== before) return undefined;
  const mean = value['mean'] as number;
  const min = value['min'] as number;
  const max = value['max'] as number;
  if (!(min <= mean && mean <= max)) {
    collector.add(path, errorCodes.CONFIG_OUT_OF_RANGE, '必须满足 0 < min <= mean <= max');
    return undefined;
  }
  const sigma = value['sigma'] as number;
  const maxSigma = max - min;
  if (sigma > maxSigma + RELATION_TOLERANCE) {
    collector.add(
      `${path}.sigma`,
      errorCodes.CONFIG_OUT_OF_RANGE,
      `必须 <= max-min（当前上界 ${maxSigma}），否则截断拒绝采样可能不收敛`,
    );
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

function requireDefinition(name: string): ParamDefinition {
  const definition = getParamDefinition(name);
  if (definition === undefined) {
    throw new Error(`PARAM_DEFINITIONS 缺少登记项：${name}`);
  }
  return definition;
}

function requireNumberDomain(name: string): NumericDomain {
  const domain = requireDefinition(name).domain;
  if (domain.kind !== 'number') {
    throw new Error(`参数 ${name} 不是数值域`);
  }
  return domain;
}

/** 从注册表读取标量域；业务范围只在 `params.ts` 维护一份。 */
function checkRegisteredNumber(
  collector: Collector,
  value: unknown,
  path: string,
  name: string,
): number | undefined {
  return checkNumber(collector, value, path, requireNumberDomain(name));
}

function checkRegisteredEnum(
  collector: Collector,
  value: unknown,
  path: string,
  name: string,
): string | undefined {
  const domain = requireDefinition(name).domain;
  if (domain.kind !== 'enum') {
    throw new Error(`参数 ${name} 不是枚举域`);
  }
  if (typeof value !== 'string' || !domain.values.includes(value)) {
    collector.add(path, errorCodes.CONFIG_INVALID, `必须为 ${domain.values.join(' 或 ')}`);
    return undefined;
  }
  return value;
}

function registeredLength(domain: ArrayDomain, classCount: number | undefined): number | undefined {
  if (domain.length === 'classCount') return classCount;
  if (domain.length === 'classCountMinus1') {
    return classCount === undefined ? undefined : classCount - 1;
  }
  return domain.length;
}

function checkRegisteredNumberArray(
  collector: Collector,
  value: unknown,
  path: string,
  name: string,
  classCount?: number,
): readonly number[] | undefined {
  const domain = requireDefinition(name).domain;
  if (domain.kind !== 'array') {
    throw new Error(`参数 ${name} 不是数组域`);
  }
  const length = registeredLength(domain, classCount);
  if (length === undefined) return undefined;
  return checkNumberArray(collector, value, path, domain.element, {
    length,
    nonDecreasing: domain.nonDecreasing,
    sumToOne: domain.sumToOne,
    firstElement: domain.firstElement,
  });
}

/** 完整配置校验：缺字段、未知字段、NaN/Infinity、非法范围与未知版本均返回路径化错误。 */
/**
 * schema 迁移（02 §10：读取器按版本分派）。
 *
 * v1 → v2：v2 起 `openness.updateMode` 为必填（P1-10 开放度消融开关）。
 * v1 时期 O 恒为动态更新，故补 `dynamic` 保持原语义。
 * v2 → v3：v3 起 `need.referenceMode/referenceSmoothing/graceDays` 为必填
 *（rules-v6 需求参照系，changes/0008）。迁移**不得默认开新机制**：
 * 补 `referenceMode:'own'`（v2 时期 need 即 'own' 公式）、`graceDays:0`
 *（与 v5 判定计时逐位一致）、`referenceSmoothing:0.2`（'own' 不读取，仅占位）。
 * 迁移链按序执行：v1 先升 v2 再升 v3。未知版本原样返回，交由版本校验拒绝。
 */
function migrateConfigInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  let record = input as Record<string, unknown>;
  if (record['schemaVersion'] === CONFIG_SCHEMA_VERSION_V1) {
    const rawOpenness = record['openness'];
    const openness =
      typeof rawOpenness === 'object' && rawOpenness !== null && !Array.isArray(rawOpenness)
        ? { ...(rawOpenness as Record<string, unknown>) }
        : {};
    if (openness['updateMode'] === undefined) {
      openness['updateMode'] = 'dynamic';
    }
    record = { ...record, schemaVersion: CONFIG_SCHEMA_VERSION_V2, openness };
  }
  if (record['schemaVersion'] === CONFIG_SCHEMA_VERSION_V2) {
    const rawNeed = record['need'];
    const need =
      typeof rawNeed === 'object' && rawNeed !== null && !Array.isArray(rawNeed)
        ? { ...(rawNeed as Record<string, unknown>) }
        : {};
    if (need['referenceMode'] === undefined) {
      need['referenceMode'] = 'own';
    }
    if (need['referenceSmoothing'] === undefined) {
      need['referenceSmoothing'] = 0.2;
    }
    if (need['graceDays'] === undefined) {
      need['graceDays'] = 0;
    }
    record = { ...record, schemaVersion: CONFIG_SCHEMA_VERSION, need };
  }
  return record;
}

export function validateRunConfig(rawInput: unknown): ValidationResult {
  const collector = new Collector();
  const input = migrateConfigInput(rawInput);

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
    checkRegisteredNumber(
      collector,
      population['initialPopulation'],
      '$.population.initialPopulation',
      'population.initialPopulation',
    );
    classCount = checkRegisteredNumber(
      collector,
      population['classCount'],
      '$.population.classCount',
      'population.classCount',
    );
    checkRegisteredNumber(
      collector,
      population['initialValue'],
      '$.population.initialValue',
      'population.initialValue',
    );
    checkRegisteredEnum(
      collector,
      population['initialAgeMode'],
      '$.population.initialAgeMode',
      'population.initialAgeMode',
    );
    if (classCount !== undefined) {
      checkRegisteredNumberArray(
        collector,
        population['classShares'],
        '$.population.classShares',
        'population.classShares',
        classCount,
      );
    }
  }

  if (checkObject(collector, root['opportunity'], '$.opportunity', ['dailyBase', 'env0'])) {
    const opportunity = root['opportunity'];
    checkRegisteredNumber(
      collector,
      opportunity['dailyBase'],
      '$.opportunity.dailyBase',
      'opportunity.dailyBase',
    );
    if (classCount !== undefined) {
      checkRegisteredNumberArray(
        collector,
        opportunity['env0'],
        '$.opportunity.env0',
        'opportunity.env0',
        classCount,
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
      checkRegisteredNumberArray(
        collector,
        lifespan['decay'],
        '$.lifespan.decay',
        'lifespan.decay',
        classCount,
      );
    }
    checkNormal(
      collector,
      lifespan['initialLife'],
      '$.lifespan.initialLife',
      'lifespan.initialLife',
    );
    hardLifeFactor = checkRegisteredNumber(
      collector,
      lifespan['hardLifeFactor'],
      '$.lifespan.hardLifeFactor',
      'lifespan.hardLifeFactor',
    );
    hardLifeFloor = checkRegisteredNumber(
      collector,
      lifespan['hardLifeFloor'],
      '$.lifespan.hardLifeFloor',
      'lifespan.hardLifeFloor',
    );
  }

  if (checkObject(collector, root['attributes'], '$.attributes', ['ge', 'hard'])) {
    const attributes = root['attributes'];
    checkLognormal(collector, attributes['ge'], '$.attributes.ge', 'attributes.ge');
    hardMin = checkLognormal(
      collector,
      attributes['hard'],
      '$.attributes.hard',
      'attributes.hard',
    )?.min;
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
    checkRegisteredNumber(collector, root['effort']['shape'], '$.effort.shape', 'effort.shape');
  }

  if (
    checkObject(collector, root['need'], '$.need', [
      'threshold',
      'belowNeedLimit',
      'bufferDays',
      'needMultiplier',
      'envExponent',
      'referenceMode',
      'referenceSmoothing',
      'graceDays',
    ])
  ) {
    const need = root['need'];
    checkRegisteredNumber(collector, need['threshold'], '$.need.threshold', 'need.threshold');
    checkRegisteredNumber(collector, need['envExponent'], '$.need.envExponent', 'need.envExponent');
    checkRegisteredNumber(
      collector,
      need['belowNeedLimit'],
      '$.need.belowNeedLimit',
      'need.belowNeedLimit',
    );
    checkRegisteredNumber(collector, need['bufferDays'], '$.need.bufferDays', 'need.bufferDays');
    checkRegisteredEnum(
      collector,
      need['referenceMode'],
      '$.need.referenceMode',
      'need.referenceMode',
    );
    checkRegisteredNumber(
      collector,
      need['referenceSmoothing'],
      '$.need.referenceSmoothing',
      'need.referenceSmoothing',
    );
    checkRegisteredNumber(collector, need['graceDays'], '$.need.graceDays', 'need.graceDays');
    if (classCount !== undefined) {
      checkRegisteredNumberArray(
        collector,
        need['needMultiplier'],
        '$.need.needMultiplier',
        'need.needMultiplier',
        classCount,
      );
    }
  }

  if (checkObject(collector, root['descent'], '$.descent', ['days'])) {
    checkRegisteredNumber(collector, root['descent']['days'], '$.descent.days', 'descent.days');
  }

  if (
    checkObject(collector, root['ascent'], '$.ascent', [
      'crossDays',
      'returnDiscount',
      'holdingCushionDays',
    ])
  ) {
    const ascent = root['ascent'];
    checkRegisteredNumber(
      collector,
      ascent['holdingCushionDays'],
      '$.ascent.holdingCushionDays',
      'ascent.holdingCushionDays',
    );
    if (classCount !== undefined) {
      checkRegisteredNumberArray(
        collector,
        ascent['crossDays'],
        '$.ascent.crossDays',
        'ascent.crossDays',
        classCount,
      );
    }
    checkRegisteredNumberArray(
      collector,
      ascent['returnDiscount'],
      '$.ascent.returnDiscount',
      'ascent.returnDiscount',
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
    checkRegisteredNumber(
      collector,
      competition['powerValueExponent'],
      '$.competition.powerValueExponent',
      'competition.powerValueExponent',
    );
    checkRegisteredNumber(
      collector,
      competition['powerGeExponent'],
      '$.competition.powerGeExponent',
      'competition.powerGeExponent',
    );
    checkRegisteredNumber(
      collector,
      competition['powerHardExponent'],
      '$.competition.powerHardExponent',
      'competition.powerHardExponent',
    );
    checkRegisteredNumber(
      collector,
      competition['crossClassInitiatorMultiplier'],
      '$.competition.crossClassInitiatorMultiplier',
      'competition.crossClassInitiatorMultiplier',
    );
    checkRegisteredNumber(
      collector,
      competition['crossClassTargetMultiplier'],
      '$.competition.crossClassTargetMultiplier',
      'competition.crossClassTargetMultiplier',
    );
    checkRegisteredNumber(
      collector,
      competition['lossRate'],
      '$.competition.lossRate',
      'competition.lossRate',
    );
    const efficiency = checkRegisteredNumber(
      collector,
      competition['baseTransferEfficiency'],
      '$.competition.baseTransferEfficiency',
      'competition.baseTransferEfficiency',
    );
    const highToLow = checkRegisteredNumber(
      collector,
      competition['highToLowWinMultiplier'],
      '$.competition.highToLowWinMultiplier',
      'competition.highToLowWinMultiplier',
    );
    const lowToHigh = checkRegisteredNumber(
      collector,
      competition['lowToHighWinMultiplier'],
      '$.competition.lowToHighWinMultiplier',
      'competition.lowToHighWinMultiplier',
    );
    checkRegisteredNumber(
      collector,
      competition['candidateCount'],
      '$.competition.candidateCount',
      'competition.candidateCount',
    );
    checkRegisteredNumber(
      collector,
      competition['localTargetProbability'],
      '$.competition.localTargetProbability',
      'competition.localTargetProbability',
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
    const maxDegree = checkRegisteredNumber(
      collector,
      network['maxDegree'],
      '$.network.maxDegree',
      'network.maxDegree',
    );
    const initialDegree = checkRegisteredNumber(
      collector,
      network['initialDegree'],
      '$.network.initialDegree',
      'network.initialDegree',
    );
    checkPairOrder(
      collector,
      initialDegree,
      maxDegree,
      '$.network.initialDegree',
      'initialDegree 必须 <= maxDegree',
    );
    checkRegisteredNumber(
      collector,
      network['rewireProb'],
      '$.network.rewireProb',
      'network.rewireProb',
    );
    checkRegisteredNumber(
      collector,
      network['classWeight'],
      '$.network.classWeight',
      'network.classWeight',
    );
    checkRegisteredNumber(
      collector,
      network['valueWeight'],
      '$.network.valueWeight',
      'network.valueWeight',
    );
  }

  if (
    checkObject(collector, root['networkOpportunity'], '$.networkOpportunity', [
      'beta',
      'min',
      'max',
    ])
  ) {
    const opportunity = root['networkOpportunity'];
    checkRegisteredNumber(
      collector,
      opportunity['beta'],
      '$.networkOpportunity.beta',
      'networkOpportunity.beta',
    );
    const min = checkRegisteredNumber(
      collector,
      opportunity['min'],
      '$.networkOpportunity.min',
      'networkOpportunity.min',
    );
    const max = checkRegisteredNumber(
      collector,
      opportunity['max'],
      '$.networkOpportunity.max',
      'networkOpportunity.max',
    );
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
    checkRegisteredNumber(
      collector,
      dynamics['classSmoothing'],
      '$.dynamics.classSmoothing',
      'dynamics.classSmoothing',
    );
    checkRegisteredNumber(
      collector,
      dynamics['congestionExponent'],
      '$.dynamics.congestionExponent',
      'dynamics.congestionExponent',
    );
    checkRegisteredNumber(
      collector,
      dynamics['polarizationExponent'],
      '$.dynamics.polarizationExponent',
      'dynamics.polarizationExponent',
    );
    checkRegisteredNumber(
      collector,
      dynamics['giniReference'],
      '$.dynamics.giniReference',
      'dynamics.giniReference',
    );
    const congestionMin = checkRegisteredNumber(
      collector,
      dynamics['congestionMin'],
      '$.dynamics.congestionMin',
      'dynamics.congestionMin',
    );
    const congestionMax = checkRegisteredNumber(
      collector,
      dynamics['congestionMax'],
      '$.dynamics.congestionMax',
      'dynamics.congestionMax',
    );
    checkPairOrder(
      collector,
      congestionMin,
      congestionMax,
      '$.dynamics.congestionMin',
      'congestionMin 必须 <= congestionMax',
    );
    checkRegisteredNumber(
      collector,
      dynamics['emptyClassPopulationFloor'],
      '$.dynamics.emptyClassPopulationFloor',
      'dynamics.emptyClassPopulationFloor',
    );
    const polarizationMin = checkRegisteredNumber(
      collector,
      dynamics['polarizationMin'],
      '$.dynamics.polarizationMin',
      'dynamics.polarizationMin',
    );
    const polarizationMax = checkRegisteredNumber(
      collector,
      dynamics['polarizationMax'],
      '$.dynamics.polarizationMax',
      'dynamics.polarizationMax',
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
      'updateMode',
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
    checkRegisteredEnum(
      collector,
      openness['updateMode'],
      '$.openness.updateMode',
      'openness.updateMode',
    );
    checkRegisteredNumber(collector, openness['initial'], '$.openness.initial', 'openness.initial');
    checkRegisteredNumber(
      collector,
      openness['timeConstantDays'],
      '$.openness.timeConstantDays',
      'openness.timeConstantDays',
    );
    checkRegisteredNumber(
      collector,
      openness['intercept'],
      '$.openness.intercept',
      'openness.intercept',
    );
    checkRegisteredNumber(
      collector,
      openness['mobilityWeight'],
      '$.openness.mobilityWeight',
      'openness.mobilityWeight',
    );
    checkRegisteredNumber(
      collector,
      openness['mobilityReference'],
      '$.openness.mobilityReference',
      'openness.mobilityReference',
    );
    checkRegisteredNumber(
      collector,
      openness['giniWeight'],
      '$.openness.giniWeight',
      'openness.giniWeight',
    );
    checkRegisteredNumber(
      collector,
      openness['segregationWeight'],
      '$.openness.segregationWeight',
      'openness.segregationWeight',
    );
    checkRegisteredNumber(
      collector,
      openness['segregationReference'],
      '$.openness.segregationReference',
      'openness.segregationReference',
    );
    checkRegisteredNumber(
      collector,
      openness['ascentCostWeight'],
      '$.openness.ascentCostWeight',
      'openness.ascentCostWeight',
    );
    const min = checkRegisteredNumber(
      collector,
      openness['multiplierMin'],
      '$.openness.multiplierMin',
      'openness.multiplierMin',
    );
    const max = checkRegisteredNumber(
      collector,
      openness['multiplierMax'],
      '$.openness.multiplierMax',
      'openness.multiplierMax',
    );
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
    checkRegisteredNumber(
      collector,
      decision['interval'],
      '$.decision.interval',
      'decision.interval',
    );
    checkRegisteredNumber(collector, decision['topK'], '$.decision.topK', 'decision.topK');
    checkRegisteredEnum(collector, decision['policy'], '$.decision.policy', 'decision.policy');
  }

  if (
    checkObject(collector, root['schedule'], '$.schedule', [
      'totalTicks',
      'statsStride',
      'snapshotStride',
    ])
  ) {
    const schedule = root['schedule'];
    const totalTicks = checkRegisteredNumber(
      collector,
      schedule['totalTicks'],
      '$.schedule.totalTicks',
      'schedule.totalTicks',
    );
    const statsStride = checkRegisteredNumber(
      collector,
      schedule['statsStride'],
      '$.schedule.statsStride',
      'schedule.statsStride',
    );
    checkRegisteredNumber(
      collector,
      schedule['snapshotStride'],
      '$.schedule.snapshotStride',
      'schedule.snapshotStride',
    );
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
    checkRegisteredNumber(
      collector,
      metrics['flowWindowDays'],
      '$.metrics.flowWindowDays',
      'metrics.flowWindowDays',
    );
    checkRegisteredNumber(
      collector,
      metrics['mobilityWindowDays'],
      '$.metrics.mobilityWindowDays',
      'metrics.mobilityWindowDays',
    );
    checkRegisteredNumber(
      collector,
      metrics['topWealthShareFraction'],
      '$.metrics.topWealthShareFraction',
      'metrics.topWealthShareFraction',
    );
  }

  if (!collector.ok) {
    return { ok: false, issues: collector.issues };
  }
  return { ok: true, config: input as unknown as RunConfig, issues: [] };
}

export function isValidRunConfig(input: unknown): input is RunConfig {
  return validateRunConfig(input).ok;
}
