import type admin from "firebase-admin";

/** Duck-type guard for `admin.firestore.Timestamp`. The admin SDK can hand
 *  back a `FieldValue` sentinel for a doc that was just written with
 *  `serverTimestamp()` and read back in the same RPC under emulator/high-
 *  latency conditions; mappers use this guard to fall back to an epoch
 *  rather than crashing on `.toDate()`. */
export function isTimestamp(value: unknown): value is admin.firestore.Timestamp {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  );
}
