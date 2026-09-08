#!/usr/bin/env bash
# amda-skill-selfcheck.sh — 让 ~/.claude/skills/AMDA 与 AMTools 仓库中的真源保持同步。
# 真源 = AMTools/skills/AMDA。请只修改真源，不要直接改运行时副本。
# 用法：bash <repo>/scripts/skill-selfcheck.sh
set -u

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${AMDA_PROJECT_DIR:-$(cd "$SELF/.." && pwd)}"
REPO_ROOT="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true)"
DST="$HOME/.claude/skills"
MANIFEST="$HOME/.claude/.ai-managed-skills-amda"

[ -f "$REPO/SKILL.md" ] || { echo "[amda-skill-selfcheck] 找不到 AMDA 真源: $REPO/SKILL.md" >&2; exit 0; }
mkdir -p "$DST"

# 每次都整库同步（容错，网络问题不阻塞技能使用）
if [ -n "$REPO_ROOT" ]; then
  timeout 20 git -C "$REPO_ROOT" pull --rebase --quiet 2>/dev/null || true
fi

name="AMDA"
t="$DST/$name/SKILL.md"
if [ ! -f "$t" ] || ! diff -q "$REPO/SKILL.md" "$t" >/dev/null 2>&1; then
  rm -rf -- "$DST/$name"
  mkdir -p "$DST/$name"
  cp -rf "$REPO/SKILL.md" "$REPO/agents" "$REPO/examples" "$REPO/references" "$REPO/scripts" "$REPO/templates" "$DST/$name/" 2>/dev/null
  echo "[amda-skill-selfcheck] 已把运行时AMDA同步到AMTools当前内容:${name}"
fi

printf '%s\n' "$name" > "$MANIFEST"
exit 0
