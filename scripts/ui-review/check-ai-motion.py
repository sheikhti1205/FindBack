import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("FINDBACK_REVIEW_OUT", "/tmp/opencode/ai-motion-evidence"))
OUT.mkdir(exist_ok=True)
CHROME = "/home/sheikh/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
CHROME = os.environ.get("FINDBACK_REVIEW_CHROME", CHROME)
BASE = os.environ.get("FINDBACK_REVIEW_URL", "http://localhost:5199")
HARNESS = "/@fs" + str(Path(__file__).with_name("ai-motion.tsx").resolve())
results = []

def overflow(page):
    return page.evaluate("""() => {
      const width = innerWidth;
      return [...document.querySelectorAll('#review-root *')].filter(el => {
        const b = el.getBoundingClientRect();
        return b.width && (b.right > width + 1 || b.left < -1);
      }).slice(0, 10).map(el => ({tag: el.tagName, text: el.textContent.slice(0, 100), width: el.getBoundingClientRect().width}));
    }""")

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    # Production-style static scrolling ancestor: exiting nodes must not jump
    # by scrollTop when popped out of normal flow.
    for reduce in (False, True):
        context = browser.new_context(viewport={"width": 320, "height": 800})
        page = context.new_page()
        page.goto(BASE, wait_until="networkidle")
        page.evaluate("url => import(url)", HARNESS)
        page.wait_for_function("window.review !== undefined")
        page.evaluate("reduce => window.review.render('scrolled', 'dark', 'standard', reduce)", reduce)
        page.get_by_test_id("scroll-parent").wait_for()
        sample = page.evaluate("""async () => {
          const scroll = document.querySelector('[data-testid="scroll-parent"]');
          scroll.scrollTop = 50;
          const old = document.querySelector('[data-testid="state-swap"]');
          const listParent = document.querySelector('[data-testid="list-parent"]');
          const list = listParent.querySelector('div[style*="opacity"]');
          const before = {swap: old.getBoundingClientRect().top, listOffset: list.getBoundingClientRect().top - listParent.getBoundingClientRect().top};
          [...document.querySelectorAll('button')].find(b => b.textContent === 'empty').click();
          await new Promise(requestAnimationFrame);
          return {before, after: {swap: old.getBoundingClientRect().top, listOffset: list.getBoundingClientRect().top - listParent.getBoundingClientRect().top}};
        }""")
        assert abs(sample["before"]["swap"] - sample["after"]["swap"]) < 1, sample
        assert abs(sample["before"]["listOffset"] - sample["after"]["listOffset"]) < 1, sample
        results.append({"surface": "scrolled-motion", "reduce": reduce, "positions": sample})
        context.close()
    for width in (320, 360, 390):
        for theme in ("light", "dark", "amoled"):
            for scale in ("standard", "xlarge"):
                context = browser.new_context(viewport={"width": width, "height": 800})
                page = context.new_page()
                page.goto(BASE, wait_until="networkidle")
                page.evaluate("url => import(url)", HARNESS)
                page.wait_for_function("window.review !== undefined")
                page.evaluate("([theme, scale]) => window.review.render('models', theme, scale)", [theme, scale])
                page.get_by_role("heading", name="On-device AI", exact=True).wait_for()
                page.screenshot(path=str(OUT / f"models-{width}-{theme}-{scale}.png"), full_page=True)
                bad = overflow(page)
                results.append({"surface": "models", "width": width, "theme": theme, "scale": scale, "overflow": bad})
                assert not bad, results[-1]
                # Progress / success and keyboard-visible control states.
                if width == 320 and scale == "standard":
                    page.evaluate("window.review.install(); window.review.progress()")
                    page.get_by_role("button", name="Verify Local text tools").wait_for()
                    page.keyboard.press("Tab")
                    page.screenshot(path=str(OUT / f"models-{width}-{theme}-lifecycle.png"), full_page=True)
                    assert not overflow(page)
                context.close()

    # Advanced acquisition/evaluation is a deliberately disclosed surface: review
    # it rendered at the same widths/themes/scales and reject horizontal overflow.
    for width in (320, 360, 390):
        for theme in ("light", "dark", "amoled"):
            for scale in ("standard", "xlarge"):
                context = browser.new_context(viewport={"width": width, "height": 800})
                page = context.new_page()
                page.goto(BASE, wait_until="networkidle")
                page.evaluate("url => import(url)", HARNESS)
                page.wait_for_function("window.review !== undefined")
                page.evaluate("([theme, scale]) => window.review.render('advanced', theme, scale)", [theme, scale])
                page.get_by_role("region", name="Advanced model acquisition and evaluation").wait_for()
                page.screenshot(path=str(OUT / f"advanced-{width}-{theme}-{scale}.png"), full_page=True)
                bad = overflow(page)
                results.append({"surface": "advanced", "width": width, "theme": theme, "scale": scale, "overflow": bad})
                assert not bad, results[-1]
                context.close()

    # Frame-by-frame flow-height proof: production StateSwap AND PostList.
    for reduce in (False, True):
        context = browser.new_context(viewport={"width": 320, "height": 800}, reduced_motion="reduce" if reduce else "no-preference")
        page = context.new_page()
        page.goto(BASE, wait_until="networkidle")
        page.evaluate("url => import(url)", HARNESS)
        page.wait_for_function("window.review !== undefined")
        page.evaluate("reduce => window.review.render('motion', 'dark', 'standard', reduce)", reduce)
        page.get_by_test_id("swap-parent").wait_for()
        for state in ("empty", "loading", "error", "loading", "content", "empty"):
            before = page.locator('[data-testid="list-parent"]').evaluate("el => el.getBoundingClientRect().height")
            samples = page.evaluate("""async state => {
              const samples = [];
              const record = () => {
                const swap = document.querySelector('[data-testid="swap-parent"]');
                const list = document.querySelector('[data-testid="list-parent"]');
                samples.push({swap: swap.getBoundingClientRect().height, list: list.getBoundingClientRect().height});
              };
              [...document.querySelectorAll('button')].find(b => b.textContent === state).click();
              for (let i = 0; i < 24; i++) { await new Promise(requestAnimationFrame); record(); }
              return samples;
            }""", state)
            after = samples[-1]["list"]
            assert max(s["swap"] for s in samples) <= 202.5, samples
            assert max(s["list"] for s in samples) <= max(before, after) + 1, {"state": state, "before": before, "after": after, "samples": samples}
            results.append({"surface": "motion", "reduce": reduce, "state": state, "before": before, "after": after, "samples": samples})
            page.screenshot(path=str(OUT / f"motion-{reduce}-{state}.png"))
        page.get_by_role("button", name="loading", exact=True).click()
        page.wait_for_timeout(220)
        interrupted = page.evaluate("""async () => {
          const list = document.querySelector('[data-testid="list-parent"]');
          const maxHeight = list.getBoundingClientRect().height;
          const samples = [];
          for (const state of ['content', 'error', 'empty', 'loading', 'content', 'empty']) {
            [...document.querySelectorAll('button')].find(b => b.textContent === state).click();
            await new Promise(requestAnimationFrame);
            samples.push(list.getBoundingClientRect().height);
          }
          for (let i = 0; i < 15; i++) { await new Promise(requestAnimationFrame); samples.push(list.getBoundingClientRect().height); }
          return {maxHeight, samples};
        }""")
        assert max(interrupted["samples"]) <= interrupted["maxHeight"] + 1, interrupted
        results.append({"surface": "interrupted-motion", "reduce": reduce, **interrupted})
        context.close()
    browser.close()
(OUT / "results.json").write_text(json.dumps(results, indent=2))
print(f"PASS: {len(results)} rendered scenarios; no horizontal overflow or doubled flow heights. Evidence: {OUT}")
