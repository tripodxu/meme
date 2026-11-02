/**
 * 语义 hash 的 domain。每个 domain 版本化；覆盖字段变化必须升级版本，
 * 不得复用旧 domain 的含义。
 */
export const HASH_DOMAINS = {
  config: 'stratify-config-v1',
  params: 'stratify-params-v1',
  initialPopulation: 'stratify-initial-population-v1',
  decisionState: 'stratify-decision-state-v1',
  actionSet: 'stratify-action-set-v1',
  tickRow: 'stratify-tick-row-v1',
  agentRow: 'stratify-agent-row-v1',
  authoritativeState: 'stratify-authoritative-state-v1',
  summary: 'stratify-summary-v1',
  artifactManifest: 'stratify-artifact-manifest-v1',
  preregistration: 'stratify-preregistration-v1',
  labelThresholds: 'stratify-label-thresholds-v1',
} as const;

export type HashDomainName = keyof typeof HASH_DOMAINS;
export type HashDomain = (typeof HASH_DOMAINS)[HashDomainName];
