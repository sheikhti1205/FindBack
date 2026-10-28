import { createChatMediaEndpoint } from "./handler.ts";
// Deploy with --no-verify-jwt; the wrapper verifies the caller's user JWT.
export default { fetch: createChatMediaEndpoint() };
