import { createEvidenceCopyEndpoint } from "./handler.ts";

// Deploy with --no-verify-jwt: the canonical wrapper verifies the server secret
// API key. No anonymous/public/user route is permitted to claim evidence work.
export default { fetch: createEvidenceCopyEndpoint() };
