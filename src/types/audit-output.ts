/**
 * AuditOutput - The Auditor's bounded scope definition
 *
 * The Auditor defines WHAT (objective, boundaries, constraints).
 * The Executor decides HOW (which tools to invoke).
 *
 * CRITICAL: No steps[], no investigation_steps[], no prescriptive instructions.
 */

export interface AuditOutput {
  /**
   * Context from the Auditor's analysis
   */
  context: {
    /** What the Auditor believes is broken */
    hypothesis: string;

    /** Files most likely involved in the bug */
    likely_files: string[];

    /** 0-1 confidence in the hypothesis */
    confidence: number;
  };

  /**
   * Boundaries for the Executor
   * The Executor operates WITHIN these boundaries but decides HOW
   */
  audit: {
    /** Clear statement of what "fixed" means - the objective */
    objective: string;

    /** File scope restrictions */
    scope: {
      /** Glob patterns the Executor MAY modify */
      allowed_patterns: string[];

      /** Glob patterns the Executor MUST NOT touch */
      forbidden_patterns: string[];

      /** Upper bound on number of files changed */
      max_file_changes: number;
    };

    /** What MUST NOT happen (negative constraints) */
    constraints: string[];

    /** How to verify the fix worked (positive assertions) */
    success_criteria: string[];
  };
}
