import { createChatMediaCleanupEndpoint } from "./handler.ts";

// Deploy with --no-verify-jwt: the canonical wrapper verifies the server secret
// API key. No anonymous/public/user route is permitted to sweep private media.
export default { fetch: createChatMediaCleanupEndpoint() };
