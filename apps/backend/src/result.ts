import type { OperationError, Result, ValidationIssue } from "@t3-factory/contracts";

export const failure = (
  code: OperationError["code"],
  message: string,
  issues: readonly ValidationIssue[] = [],
): Result<never> => ({ ok: false, error: { code, message, issues } });
