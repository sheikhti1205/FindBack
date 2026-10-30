import { createTrustMaintenanceEndpoint } from "./handler.ts";

// --no-verify-jwt: the pinned canonical SDK verifies the internal secret key.
// No consumer route is allowed to expire appeals or erase report evidence.
export default { fetch: createTrustMaintenanceEndpoint() };
