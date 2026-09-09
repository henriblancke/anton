/**
 * Where a headless claude spawn's traffic goes, as anton's own environment declares it.
 *
 * One name for the variable, shared by the spawn side and the spend ledger, so "which endpoint
 * served this invocation" is answered from the same place the child was pointed at rather than from
 * a second, drifting copy of the string.
 *
 * The gateway routing work (anton-72hj) declares the same variable in `driver-routing.ts` alongside
 * the other two it controls. When both are on one branch, that module should import this constant
 * rather than redeclare it — the ledger's `endpoint_host` and the child's `ANTHROPIC_BASE_URL` must
 * name the same endpoint or the recorded dimension is a guess.
 */
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
