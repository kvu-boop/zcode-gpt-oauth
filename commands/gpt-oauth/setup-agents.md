---
description: Apply the bundled preset AGENTS.md + subagents (with backup)
---

# gpt-oauth: Setup Agents

Apply the author's bundled ZCode preset config shipped with this plugin: the `AGENTS.md` orchestration policy and the subagent definitions (`worker`, `ui-expert`, `reviewer`, and the plan `template`). The current `~/.zcode/AGENTS.md` and `~/.zcode/agents/*.md` are first backed up, then overwritten, and any `model:` references to the author's private providers are neutralized so subagents fall back to the default model on machines that do not have those providers.

## Steps

1. **Locate the bundled preset directory** (installed alongside this plugin):
   - Run: `ls -d ~/.zcode/cli/plugins/cache/zcode-gpt-oauth/gpt-oauth/*/preset/ 2>/dev/null`
   - The glob covers any installed release (e.g. `gpt-oauth/0.2.0/preset/`). If multiple versions are installed, prefer the newest (`sort -V` → last entry).
   - **If no `preset/` directory is found**: the user has an outdated plugin — tell them to update the plugin (Settings → Plugin Management → update gpt-oauth, then restart ZCode) and **STOP**.

2. **Back up existing targets before touching anything** (one shared timestamp per run):
   - `TS=$(date +%Y%m%d%H%M%S)`
   - If `~/.zcode/AGENTS.md` exists → `cp ~/.zcode/AGENTS.md ~/.zcode/AGENTS.md.bak-$TS`
   - For each `.md` file present in the preset `agents/` folder that already exists at `~/.zcode/agents/`, back it up: `cp ~/.zcode/agents/<name>.md ~/.zcode/agents/<name>.md.bak-$TS` (files that do not exist yet are new; no backup needed).
   - Backups go **next to the originals** (same directory), so the workflow is reversible.

3. **Apply the preset files**:
   - `mkdir -p ~/.zcode/agents`
   - `cp <PRESET>/AGENTS.md ~/.zcode/AGENTS.md`
   - `cp <PRESET>/agents/*.md ~/.zcode/agents/`

4. **Neutralize model references to the author's private providers** (target machines don't have the author's provider UUIDs):
   - For each copied agent file under `~/.zcode/agents/`, inspect its frontmatter for lines shaped `model: "custom:<uuid>:<model>"`.
   - With **python3** (never `echo`/print any provider `apiKey` or options values), load `~/.zcode/v2/config.json` and collect the set of keys of its top-level `provider` object. If the file is missing or has no `provider` object, treat the set as empty.
   - For each line `model: "custom:<uuid>:<model>"`: if `<uuid>` is **NOT** in the provider key set, rewrite that single line to `# model: "custom:<uuid>:<model>"` (prefix `# `) so the subagent falls back to the default model, and record the file path. If `<uuid>` **IS** in the provider key set, leave the line unchanged.
   - Work only on the literal `model:` frontmatter lines; do not touch anything else in the file.

5. **Report to the user**:
   - Files applied (AGENTS.md and the agent `.md` files copied).
   - Files backed up, with full backup paths (e.g. `~/.zcode/AGENTS.md.bak-<TS>`).
   - Which agent files had their `model:` line commented out (the `<uuid>` was not present on this machine).
   - Tell the user: "Open Settings → Subagents and pick the model for each subagent to match YOUR providers (e.g. gpt-5.6-* if you set up gpt-oauth)".
   - State how to roll back: restore the backups, e.g. `cp ~/.zcode/AGENTS.md.bak-<TS> ~/.zcode/AGENTS.md` (and the same for each `~/.zcode/agents/<name>.md.bak-<TS>`).

## Rules

- **Never read, print, or echo secrets from `~/.zcode/v2/config.json`.** When parsing it, redact/mask all `apiKey` and options values; only ever mention provider *key ids* (the UUIDs) you need to compare against model lines.
- Do not delete or modify any `.bak-*` files.
- If anything in step 2–4 fails midway, report exactly which step failed and leave the backups in place so the user can roll back.