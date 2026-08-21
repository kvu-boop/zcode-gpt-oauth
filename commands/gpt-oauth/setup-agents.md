---
description: Apply the bundled preset AGENTS.md + subagents (with backup)
---

# gpt-oauth: Setup Agents

Apply the author's bundled ZCode preset config shipped with this plugin: the `AGENTS.md` orchestration policy and the subagent definitions (`worker`, `ui-expert`, `reviewer`, and the plan `template`). The current `~/.zcode/AGENTS.md` and `~/.zcode/agents/*.md` are first backed up, then overwritten, and any `model:` references to the author's private providers are neutralized so subagents fall back to the default model on machines that do not have those providers.

> **Cross-platform:** this command works on macOS, Linux and Windows. Every shell-dependent step below gives **both** forms (bash for macOS/Linux, PowerShell for Windows). **Detect your platform first** so you pick the right commands.

## Step 0 — Detect your platform

- **macOS / Linux (Unix):** run `uname`. An output like `Darwin` (macOS) or `Linux` means use the **bash** commands below.
- **Windows:** run `$env:OS` in PowerShell. An output of `Windows_NT` means use the **PowerShell** commands below.

Conventions for the rest of this command: the Unix home `~` is `%USERPROFILE%` / `$env:USERPROFILE` on Windows, and `/` path separators become `\`.

## Step 1 — Locate the bundled preset directory

The preset is installed alongside this plugin under the plugin cache.

**macOS / Linux:**
```bash
PRESET=$(ls -d ~/.zcode/cli/plugins/cache/zcode-gpt-oauth/gpt-oauth/*/preset/ 2>/dev/null | sort -V | tail -1)
echo "$PRESET"
```

**Windows (PowerShell):**
```powershell
$latest = Get-ChildItem "$env:USERPROFILE\.zcode\cli\plugins\cache\zcode-gpt-oauth\gpt-oauth" -Directory | Sort-Object Name | Select-Object -Last 1
$PRESET = Join-Path $latest.FullName 'preset'
$PRESET
```

The glob / directory listing covers any installed release (e.g. `gpt-oauth/0.2.2/preset/`); if multiple versions are installed, prefer the newest (sorted → last entry). Keep `$PRESET` for the next steps.

**If no `preset/` directory is found**: the user has an outdated plugin — tell them to update the plugin (Settings → Plugin Management → update gpt-oauth, then restart ZCode) and **STOP**.

## Step 2 — Generate one shared timestamp per run

Used for every `.bak-<timestamp>` suffix so a single run produces a single restore point.

**macOS / Linux:**
```bash
TS=$(date +%Y%m%d%H%M%S)
```

**Windows (PowerShell):**
```powershell
$TS = Get-Date -Format yyyyMMddHHmmss
```

## Step 3 — Back up existing targets before touching anything

Backups go **next to the originals** (same directory), so the workflow is reversible. Only files that already exist are backed up; files that do not exist yet are new and need no backup.

**macOS / Linux:**
```bash
[ -f ~/.zcode/AGENTS.md ] && cp ~/.zcode/AGENTS.md ~/.zcode/AGENTS.md.bak-$TS
for f in "$PRESET"/agents/*.md; do
  name="$(basename "$f")"
  [ -f ~/.zcode/agents/"$name" ] && cp ~/.zcode/agents/"$name" ~/.zcode/agents/"$name".bak-$TS
done
```

**Windows (PowerShell):**
```powershell
if (Test-Path "$env:USERPROFILE\.zcode\AGENTS.md") {
  Copy-Item "$env:USERPROFILE\.zcode\AGENTS.md" "$env:USERPROFILE\.zcode\AGENTS.md.bak-$TS"
}
Get-ChildItem "$PRESET\agents" -Filter *.md | ForEach-Object {
  $dest = "$env:USERPROFILE\.zcode\agents\$($_.Name)"
  if (Test-Path $dest) { Copy-Item $dest "$dest.bak-$TS" }
}
```

## Step 4 — Apply the preset files

**macOS / Linux:**
```bash
mkdir -p ~/.zcode/agents
cp "$PRESET"/AGENTS.md ~/.zcode/AGENTS.md
cp "$PRESET"/agents/*.md ~/.zcode/agents/
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.zcode\agents" | Out-Null
Copy-Item "$PRESET\AGENTS.md" "$env:USERPROFILE\.zcode\AGENTS.md"
Copy-Item "$PRESET\agents\*.md" "$env:USERPROFILE\.zcode\agents\"
```

## Step 5 — Neutralize model references to the author's private providers

Target machines don't have the author's provider UUIDs, so any frontmatter line `model: "custom:<uuid>:<model>"` whose `<uuid>` is **not** configured on *this* machine must be commented out (`# ` prefix) so the subagent falls back to the default model.

Use the pure-python script below — it works unchanged on macOS, Linux and Windows (no shell syntax inside). Do **not** try to do this with bash/PowerShell one-liners.

1. Save the script below to a temp file with your Write tool: macOS/Linux `$TMPDIR/neutralize_models.py` (or `/tmp/neutralize_models.py`); Windows `$env:TEMP\neutralize_models.py` (i.e. `%TEMP%\neutralize_models.py`).
2. Choose the Python interpreter to run it with:
   - **macOS / Linux:** `python3`.
   - **Windows:** try `python` first; if that command is not found, try `py -3` (in that order).
3. Run it with the agents dir and config path as the two arguments:
   - **macOS / Linux:** `python3 /tmp/neutralize_models.py ~/.zcode/agents ~/.zcode/v2/config.json`
   - **Windows:** `python "$env:TEMP\neutralize_models.py" "$env:USERPROFILE\.zcode\agents" "$env:USERPROFILE\.zcode\v2\config.json"` (or the same with `py -3` if `python` was unavailable).

What the script does (the exact logic ported from the previous version of this command):

- Loads the JSON config and collects the set of keys of its top-level `provider` object. If the file is missing or has no `provider` object, the set is empty.
- For each `.md` file under the agents dir, for each line shaped `model: "custom:<uuid>:<model>"`: if `<uuid>` is **NOT** in the provider key set, that single line is rewritten to `# model: "custom:<uuid>:<model>"`; if `<uuid>` **IS** in the set, the line is left unchanged.
- Works only on the literal `model:` frontmatter lines; nothing else in the file is touched.
- **Never prints `apiKey`, `options`, or any other value from the config** — only file names.

```python
#!/usr/bin/env python3
# neutralize_models.py — pure python, no shell. Works on macOS, Linux, Windows.
import json
import os
import re
import sys

MODEL_LINE = re.compile(r'^(\s*)model:\s*"custom:([^":]+):(.*)"\s*$')


def read_provider_keys(config_path):
    try:
        with open(config_path, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return set()
    if not isinstance(data, dict):
        return set()
    providers = data.get('provider')
    if not isinstance(providers, dict):
        return set()
    return set(providers.keys())


def neutralize_file(path, keys):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            lines = fh.readlines()
    except OSError:
        return False
    changed = False
    out = []
    for line in lines:
        match = MODEL_LINE.match(line.rstrip('\r\n'))
        if not match:
            out.append(line)
            continue
        indent, uuid_, model = match.groups()
        if uuid_ in keys:
            out.append(line)
            continue
        newline = '\r\n' if line.endswith('\r\n') else ('\n' if line.endswith('\n') else '')
        out.append(indent + '# model: "custom:' + uuid_ + ':' + model + '"' + newline)
        changed = True
    if changed:
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(''.join(out))
    return changed


def main():
    if len(sys.argv) != 3:
        sys.stderr.write('usage: neutralize_models.py AGENTS_DIR CONFIG_PATH\n')
        return 2
    agents_dir, config_path = sys.argv[1], sys.argv[2]
    keys = read_provider_keys(config_path)
    changed_files = []
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            if not name.endswith('.md'):
                continue
            full = os.path.join(agents_dir, name)
            if os.path.isfile(full) and neutralize_file(full, keys):
                changed_files.append(name)
    if not changed_files:
        print('No model lines needed neutralization: every custom:<uuid> provider referenced under %s already exists in %s.' % (agents_dir, config_path))
        return 0
    print('Commented out model: lines pointing at missing providers in %d file(s) under %s:' % (len(changed_files), agents_dir))
    for name in changed_files:
        print('  - %s' % name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

## Step 6 — Report to the user

- Files applied: `AGENTS.md` and the agent `.md` files copied.
- Files backed up, with full backup paths (e.g. `~/.zcode/AGENTS.md.bak-<TS>` / `%USERPROFILE%\.zcode\AGENTS.md.bak-<TS>`).
- Which agent files had their `model:` line commented out (the `<uuid>` was not present on this machine).
- Tell the user: "Open Settings → Subagents and pick the model for each subagent to match YOUR providers (e.g. gpt-5.6-* if you set up gpt-oauth)".
- State how to roll back (restore the backups):
  - **macOS / Linux:** `cp ~/.zcode/AGENTS.md.bak-<TS> ~/.zcode/AGENTS.md` (and the same for each `~/.zcode/agents/<name>.md.bak-<TS>`).
  - **Windows:** `Copy-Item "$env:USERPROFILE\.zcode\AGENTS.md.bak-<TS>" "$env:USERPROFILE\.zcode\AGENTS.md"` (and the same for each `$env:USERPROFILE\.zcode\agents\<name>.md.bak-<TS>`).

## Rules

- **Never read, print, or echo secrets from `~/.zcode/v2/config.json` (or `%USERPROFILE%\.zcode\v2\config.json` on Windows).** When parsing it, redact/mask all `apiKey` and `options` values; only ever mention provider *key ids* (the UUIDs) you need to compare against model lines.
- Do not delete or modify any `.bak-*` files.
- If anything in steps 2–5 fails midway, report exactly which step failed and leave the backups in place so the user can roll back.