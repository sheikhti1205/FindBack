import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ["FINDBACK_REVIEW_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
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
                page.get_by_role("heading", name="Downloaded models", exact=True).wait_for()
                page.get_by_text("Not downloaded", exact=True).wait_for()
                page.screenshot(path=str(OUT / f"models-{width}-{theme}-{scale}.png"), full_page=True)
                bad = overflow(page)
                results.append({"surface": "models", "width": width, "theme": theme, "scale": scale, "overflow": bad})
                assert not bad, results[-1]
                # Progress / success and keyboard-visible control states.
                if width == 320 and scale == "standard":
                    page.evaluate("window.review.install()")
                    page.get_by_role("button", name="Remove local search helper").wait_for()
                    page.keyboard.press("Tab")
                    page.screenshot(path=str(OUT / f"models-{width}-{theme}-lifecycle.png"), full_page=True)
                    assert not overflow(page)
                    page.evaluate("window.review.progress()")
                    page.get_by_role("button", name="Pause", exact=True).wait_for()
                    page.screenshot(path=str(OUT / f"models-{width}-{theme}-progress.png"), full_page=True)
                    assert not overflow(page)
                context.close()

    # Canonical cleanup, confirmation, error/retry, helper survival and focus.
    for theme in ("light", "dark", "amoled"):
        for scale in ("standard", "xlarge"):
            context = browser.new_context(viewport={"width": 320, "height": 800})
            page = context.new_page()
            page.goto(BASE, wait_until="networkidle")
            page.evaluate("url => import(url)", HARNESS)
            page.wait_for_function("window.review !== undefined")
            page.evaluate("([theme, scale]) => { window.review.install(); window.review.older(); window.review.render('models', theme, scale); }", [theme, scale])
            page.get_by_role("button", name="Remove older downloads", exact=True).click()
            dialog = page.get_by_role("dialog", name="Remove older downloads?", exact=True)
            dialog.wait_for()
            # Keyboard containment and non-destructive initial focus.
            page.wait_for_function("document.querySelector('[role=dialog]')?.contains(document.activeElement)")
            initial_focus = page.evaluate("document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent")
            assert initial_focus in ("Close", "Keep downloads"), initial_focus
            page.keyboard.press("Shift+Tab")
            assert dialog.evaluate("el => el.contains(document.activeElement)")
            page.keyboard.press("Tab")
            assert dialog.evaluate("el => el.contains(document.activeElement)")
            remove_button = dialog.get_by_role("button", name="Remove older downloads", exact=True)
            remove_button.scroll_into_view_if_needed()
            box = remove_button.bounding_box()
            assert box and box["y"] >= 0 and box["y"] + box["height"] <= 801, box
            # Fixed sheets are viewport surfaces; full-page screenshots stitch
            # background outside the viewport and misrepresent the scrim.
            page.screenshot(path=str(OUT / f"cleanup-{theme}-{scale}-confirm.png"))
            assert not overflow(page)
            page.evaluate("window.review.failRemoval(true)")
            dialog.get_by_role("button", name="Remove older downloads", exact=True).click()
            dialog.get_by_role("alert").wait_for()
            assert "private" not in dialog.inner_text()
            remove_button.scroll_into_view_if_needed()
            box = remove_button.bounding_box()
            assert box and box["y"] >= 0 and box["y"] + box["height"] <= 801, box
            page.screenshot(path=str(OUT / f"cleanup-{theme}-{scale}-error.png"))
            assert not overflow(page)
            page.evaluate("window.review.failRemoval(false)")
            dialog.get_by_role("button", name="Remove older downloads", exact=True).click()
            dialog.wait_for(state="detached")
            page.get_by_text("Older downloads removed. Your local search helper is unchanged.", exact=True).wait_for()
            page.wait_for_function("document.activeElement?.textContent === 'Older downloads removed. Your local search helper is unchanged.'")
            page.get_by_text("Installed", exact=True).wait_for()
            page.screenshot(path=str(OUT / f"cleanup-{theme}-{scale}-success.png"), full_page=True)
            assert not overflow(page)
            results.append({"surface": "cleanup", "width": 320, "theme": theme, "scale": scale, "confirmation": True, "failureRetry": True, "focus": True, "helperPreserved": True})
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
