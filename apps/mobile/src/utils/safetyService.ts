/**
 * Has the server got this function yet?
 *
 * HONESTY IS THE CONTRACT. A safety surface that writes to a function the
 * database does not have must say so — "not available in this build" — rather
 * than showing a failure, an empty list that reads like "you have nothing",
 * or a fake success. The client therefore recognises the shape of that
 * refusal wherever the safety services meet it.
 *
 *   PGRST202       PostgREST could not find the function in its schema cache;
 *   42883         Postgres: no such function;
 *   42P01         Postgres: no such table — the object behind the call;
 *   RPC_UNAVAILABLE  the trust service's own typed answer for the same fact.
 *
 * The codes are matched, never the message: a message is a sentence the
 * server wrote, and a sentence can change. A code is the fact.
 *
 * This module is the ONE place that knows this. A screen asks it and then
 * says which feature is missing, in words a reader can picture.
 */
import { ApiError } from "../services/session";

/** The codes that mean "the server has not got that yet". */
const MISSING_FUNCTION_CODES = ["PGRST202", "42883", "42P01", "RPC_UNAVAILABLE"] as const;

/**
 * Is this failure the "the server has not got that function yet" answer?
 *
 * False for every other failure: a refusal, a transport failure and a shape
 * mismatch are different facts and must never be dressed up as a missing
 * feature.
 */
export function isMissingServerFunction(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const code = err.code ?? "";
  return (MISSING_FUNCTION_CODES as readonly string[]).includes(code);
}
