export interface SecretHit {
  readonly pattern: string;
  readonly line: number;
}

export declare const SECRET_PATTERNS: readonly {
  readonly name: string;
  readonly regex: RegExp;
}[];

export declare function findSecretPatterns(text: string): SecretHit[];
