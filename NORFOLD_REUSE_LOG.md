# Norfold reuse log

Inspected: 2026-09-09. Local source at `/home/sheikh/GitHub/Norfold`.

## Findings
- Norfold's primary client is a native Android Jetpack Compose app
  (`apps/android`) — a different stack than FindBack's chosen Capacitor/React
  target, so Compose code is **not directly reusable**.
- Norfold also contains a thin React+Vite web shell (`apps/web`): 2 source files
  (`main.tsx`, `styles.css`). Nothing beyond generic patterns.
- Norfold brand assets are Norfold-specific and not transferred.

## Reuse decision
No Norfold source code was copied into FindBack. The following generic *concepts*
may inform FindBack design (reimplemented independently, not copied): navigation
shell idea, loading/empty/error state treatment, monochrome minimalist direction.

| Source path | Reused | Modifications | Ownership |
|---|---|---|---|
| — (none) | — | — | — |

If reusable user-owned snippets/assets are identified later they will be added here
and verified for user ownership.
