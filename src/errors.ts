/**
 * @fileoverview Framework-specific error classes.
 */

/**
 * Raised when an agent or orchestrator run exceeds its configured token budget.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'TOKEN_BUDGET_EXCEEDED'

  constructor(
    readonly agent: string,
    readonly tokensUsed: number,
    readonly budget: number,
  ) {
    super(`Agent "${agent}" exceeded token budget: ${tokensUsed} tokens used (budget: ${budget})`)
    this.name = 'TokenBudgetExceededError'
  }
}
