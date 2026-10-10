---
name: findback-ui-quality
description: Use when creating, styling, or substantially changing any FindBack consumer-facing screen, component, settings surface, composer, feed, profile, dialog, or empty/loading/error state.
---

# FindBack UI quality gate

Treat visible UI as product design, not CSS cleanup.

## Before coding

1. Inspect the existing screen and canonical shared components.
2. Inspect any owner-provided reference screenshots and extract interaction/layout principles rather than cloning branding.
3. State the screen's primary user job and the visual hierarchy in one paragraph.
4. Prefer neutral surfaces with purposeful semantic color; do not paint backgrounds for decoration.

## Ban generic AI UI

Do not default to:
- cards around every group;
- grids for ordinary settings/navigation lists;
- oversized icons or 48px-tall visual boxes just because the hit target is 48px;
- repeated rounded rectangles with borders;
- text labels where a standard icon communicates the action better;
- center-aligned dashboard layouts for social/content screens;
- developer terms on consumer surfaces;
- gratuitous gradients, glassmorphism, or animation.

## Density

Keep accessible hit targets while making the visual affordance compact. Prefer list rows, separators, whitespace, and typography over nested cards. Settings should be list-first; accent selection may remain a grid/swatches surface.

## Required states

Design and verify normal, pressed, selected, disabled, loading, empty, error, offline where relevant, large text, dark, and true-black. Long strings and 320dp width must not clip.

## Consumer copy

Use plain product language. Put diagnostics, model/runtime IDs, schemas, routing rules, cloud/local implementation detail, and debug state behind Advanced/Diagnostics.

## Rendered review

A change is not complete from DOM tests alone. Capture/render representative widths and inspect hierarchy, density, alignment, overflow, focus, IME, and transitions. Reviewer must reject technically correct UI that looks cheap, bulky, or templated.
