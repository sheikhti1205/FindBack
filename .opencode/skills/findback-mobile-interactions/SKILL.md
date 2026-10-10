---
name: findback-mobile-interactions
description: Use when changing touch gestures, carousels, long-press, reactions, pull-to-refresh, sticky headers, floating controls, sheets, keyboard behavior, swipe navigation, or motion in FindBack.
---

# FindBack mobile interaction physics

## Principle

Prefer native-feeling continuous motion over state-swap animations. The user's finger should appear to move the content whenever the interaction is spatial.

## Carousels

Use the Home feed's native scroll-snap carousel as the reference behavior: continuous horizontal travel, momentum, snap, no fade-only image replacement. Do not implement swipe as `touchEnd -> setIndex -> fade new image` unless the surface is intentionally non-spatial.

For fullscreen photos, preserve pinch/double-tap zoom and pan. At fit/1x, horizontal travel may page photos; while zoomed, horizontal drag pans the image. No gesture should accidentally trigger navigation after a swipe.

## Long press reactions

A reaction tray is a floating pill anchored above the trigger, with large expressive reaction glyphs, not a card containing labels and counts. Open after ~350–450ms, give a subtle haptic when available, allow the finger/pointer to slide across choices while still held, visually lift/scale the hovered choice, select on release, and cancel on vertical scroll. Keyboard/screen-reader users need an equivalent choose-reaction action.

## Refresh

Do not pull the post list away or replace it with text such as `Refreshing…`. Pull reveals a compact pill/circular refresh glyph that transforms/spins with progress. Existing content remains visible. After data arrives, reconcile/present changed content with a short subtle fade/position transition; avoid a blank flash.

## Navigation chrome

Back/top bars that are needed to escape a screen stay sticky/floating while content scrolls, respect safe areas, and remain visually compact. Do not let the only back affordance scroll off-screen.

## Motion

Use transform/opacity for compositor-friendly motion, respect reduced motion, avoid simultaneous competing animations, and prefer springs only where they communicate physical response.
