## Auto-update — why we rolled our own (and the gotchas)

This app is **not** signed with an Apple Developer ID, so `electron-updater`'s normal swap-and-relaunch dies the moment Gatekeeper inspects the new bundle. We replaced it with a custom flow in `src/main/updater.ts`:

1. Poll `https://api.github.com/repos/yehzu/ycal/releases/latest` (no auth — well under the 60-rps anonymous rate limit at our cadence).
2. Pick the arch-matched zip asset (`yCal-X.Y.Z-arm64-mac.zip` on Apple Silicon, `yCal-X.Y.Z-mac.zip` on Intel — `.blockmap` files share the prefix and must be skipped).
3. **Pre-fetch the zip in the background** as soon as the version is detected, into `<userData>/update-cache/yCal-<version>.zip`, broadcasting progress as `state: 'available'` with a `progress` field. When the file lands, transition to `state: 'ready'` so the toast can read "Update ready" and the user's eventual click is essentially free. The cache holds at most one zip — `pruneCache(keepVersion)` runs on every successful check.
4. Download via Node `https` (which doesn't add `com.apple.quarantine`, unlike Safari/Chrome).
5. When the user clicks Install, `performInstall` awaits any in-flight prefetch (its progress callback re-routes from 'available' → 'installing' so the splash shows real bytes-on-the-wire instead of a frozen 0%), then skips the download entirely if the cached zip is intact. Falls back to a foreground download if the cache is missing or the prefetch errored.
6. Extract with `/usr/bin/ditto` — the same tool electron-builder uses on the producing side; preserves resource forks and xattrs better than `unzip`.
7. Write a detached bash helper script and `app.quit()`. The helper waits for the old process to exit, **moves the running bundle aside (not delete-first)**, moves the new bundle into place, runs `xattr -cr` to strip Gatekeeper attrs, sanity-checks the executable, then `lsregister -f`s the path and `open -n`s it (with retries). On any failure path it restores the aside-bundle so the user is never appless.

**Why `lsregister -f` + `open -n` instead of plain `open`:** after we replace the bundle on disk, LaunchServices can hold a stale entry pointing at the (just-deleted) inode, which makes the subsequent `open` resolve to nothing and the relaunch silently fail. Re-registering the path forces LSi to pick up the new Info.plist; `-n` then forces a fresh instance instead of reusing the (no-longer-valid) record.

**The swap helper logs to `~/Library/Logs/yCal/swap.log`** in addition to the temp dir. The temp dir gets `rm -rf`'d ten seconds after the script finishes, so without the persistent copy a failed relaunch leaves no trace. If the user reports "didn't relaunch", check that file first.

**Don't try to make electron-updater work for unsigned builds again.** That was the bug we're working around: Gatekeeper requires either notarisation OR a missing quarantine bit, and electron-updater can't help with either. The bundle path is found via `process.execPath` so this works regardless of whether yCal lives in `/Applications`, `~/Applications`, or a custom location.

**Renderer contract is unchanged.** `UpdateOverlay.tsx` and `SettingsModal.tsx`'s update card still drive the lifecycle through the existing `UpdateStatus` IPC stream + `installUpdate()` channel — only the main-side mechanics changed.

**`bin/ycal` is not in the dmg.** It's a checkout-only script. If a fix lives in `bin/ycal`, users with `~/.local/bin/ycal` already symlinked or copied need to re-copy. A version bump still helps signal that.
