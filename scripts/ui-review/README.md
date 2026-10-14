# AI catalogue and shared state-transition rendered regressions

Uses Chromium and the **actual production** `AiModelsRoute`, `StateSwap` and
`PostList`, with fake app-private storage and fixed device facts. No weights,
backend writes or inference. The harness is outside the application source tree
and is imported through Vite dev; it is not an application route or release asset.

Start the mobile dev server on port 5199, then run:

```sh
npm run dev -w apps/mobile -- --port 5199 --strictPort
# In a second terminal (Python Playwright must be installed):
python3 scripts/ui-review/check-ai-motion.py
```

Overrides: `FINDBACK_REVIEW_URL`, `FINDBACK_REVIEW_CHROME` and
`FINDBACK_REVIEW_OUT`. Defaults match the local WSL Chromium installation and
write screenshots plus `results.json` to `/tmp/opencode/ai-motion-evidence`.

Assertions cover 320/360/390 CSS pixels, light/dark/true-black, standard/125%
text, long legal reasons, installed/downloading controls, keyboard-visible
focus, full/reduced motion, and interrupted swaps. Frame sampling rejects
doubled flow heights. Static scroll-parent regressions check that outgoing
content retains its scroll displacement—positioned fixture parents alone
cannot reproduce this failure.

Inspect the screenshots as well as the JSON; an assertion pass is not a visual
approval, physical-device acceptance, model qualification or a whole-app audit.
