// Vitest shared setup (apps/mobile). Registered via `test.setupFiles` in
// vite.config.ts.

import { configure } from "@testing-library/react";

// `waitFor`/`findBy*` default to a 1s polling window. Under full-suite worker
// load that is the flakiest link in the async CreateReport flows, so give it
// the same headroom the suite's own explicit 5s gates already use. This only
// extends patience; it does not relax any assertion.
if (typeof document !== "undefined") {
  configure({ asyncUtilTimeout: 5_000 });
}
