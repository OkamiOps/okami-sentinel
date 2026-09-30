/**
 * The summariser moved to `@csb/shared` when the API started describing the
 * browser behind a new sign-in in an e-mail: the alert and the session list must
 * name the same device the same way. This re-export keeps the web imports short.
 */
export { describeUserAgent } from "@csb/shared";
