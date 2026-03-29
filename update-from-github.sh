#!/usr/bin/env bash
# ==============================================================================
#  GarageBook — Update vanuit GitHub
#  Uitvoeren op de Proxmox HOST als root:
#
#    bash update-from-github.sh [CT_ID] [branch]
#
#  Eerste keer: stel GITHUB_REPO in onderaan dit script of geef het mee
#  als omgevingsvariabele:
#    GITHUB_REPO=Holewijn/garagebook bash update-from-github.sh 118
# ==============================================================================

set -euo pipefail

R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' B='\033[1m' DIM='\033[2m' NC='\033[0m'
ok()      { echo -e "  ${G}✓${NC} $*"; }
info()    { echo -e "  ${C}→${NC} $*"; }
warn()    { echo -e "  ${Y}!${NC} $*"; }
die()     { echo -e "\n  ${R}✗ FOUT:${NC} $*\n"; exit 1; }
divider() { echo -e "  ${DIM}────────────────────────────────────────${NC}"; }

[[ $EUID -ne 0 ]] && die "Voer dit script uit als root op de Proxmox host."
command -v pct  &>/dev/null || die "pct niet gevonden. Niet op een Proxmox host?"
command -v git  &>/dev/null || { info "Git installeren..."; apt-get install -y -qq git; }

# ── Configuratie ──────────────────────────────────────────────────────────────
# Pas GITHUB_REPO aan naar jouw GitHub gebruikersnaam/repository-naam
GITHUB_REPO="${GITHUB_REPO:-Holewijn/garagebook}"
REPO_URL="https://github.com/${GITHUB_REPO}.git"
REPO_DIR="${REPO_DIR:-/root/garagebook-repo}"
BRANCH="${2:-main}"

# Container ID
CT_ID="${1:-}"
if [[ -z "$CT_ID" ]]; then
  echo -e "\n  ${B}Draaiende containers:${NC}"
  pct list | grep running | awk '{printf "    ID %-6s  %s\n", $1, $3}' || true
  echo ""
  read -rp "  Container ID: " CT_ID
fi
[[ -z "$CT_ID" ]] && die "Geen container ID opgegeven."
pct status "$CT_ID" &>/dev/null || die "Container ${CT_ID} niet gevonden."
[[ "$(pct status "$CT_ID" | awk '{print $2}')" == "running" ]] || die "Container ${CT_ID} is niet actief."

echo -e "\n${B}${C}══ GarageBook update vanuit GitHub ══${NC}"
echo -e "  Repo   : ${C}${REPO_URL}${NC}"
echo -e "  Branch : ${C}${BRANCH}${NC}"
echo -e "  CT ID  : ${C}${CT_ID}${NC}\n"

# ── Stap 1: Repository klonen of bijwerken ────────────────────────────────────
info "Repository bijwerken..."

if [[ -d "$REPO_DIR/.git" ]]; then
  cd "$REPO_DIR"
  CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
  if [[ "$CURRENT_REMOTE" != "$REPO_URL" ]]; then
    warn "Remote gewijzigd. Repository opnieuw klonen..."
    rm -rf "$REPO_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
  else
    git fetch origin "$BRANCH" --quiet
    git reset --hard "origin/${BRANCH}" --quiet
  fi
else
  info "Repository klonen (eerste keer)..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

COMMIT=$(git -C "$REPO_DIR" log -1 --format="%h — %s (%ar)" 2>/dev/null || echo "onbekend")
ok "Code bijgewerkt: ${DIM}${COMMIT}${NC}"

# ── Stap 2: Backup voor update ────────────────────────────────────────────────
info "Backup aanmaken voor update..."
pct exec "$CT_ID" -- bash -c "
  if [[ -x /usr/local/bin/garagebook-backup ]]; then
    garagebook-backup
  else
    echo 'Backup script niet gevonden, overslaan.'
  fi
" && ok "Backup aangemaakt."

# ── Stap 3: Bestanden naar container pushen ───────────────────────────────────
UPDATED=0

if [[ -f "$REPO_DIR/frontend/index.html" ]]; then
  info "Frontend bijwerken..."
  pct push "$CT_ID" "$REPO_DIR/frontend/index.html" /opt/garagebook/frontend/index.html
  ok "Frontend bijgewerkt."
  UPDATED=1
else
  warn "frontend/index.html niet gevonden in repository."
fi

if [[ -f "$REPO_DIR/backend/server.js" ]]; then
  info "Backend bijwerken..."
  pct push "$CT_ID" "$REPO_DIR/backend/server.js" /opt/garagebook/backend/server.js
  ok "Backend bijgewerkt."
  UPDATED=1
fi

if [[ -f "$REPO_DIR/backend/package.json" ]]; then
  info "package.json bijwerken..."
  pct push "$CT_ID" "$REPO_DIR/backend/package.json" /opt/garagebook/backend/package.json
  info "Dependencies installeren..."
  pct exec "$CT_ID" -- bash -c "cd /opt/garagebook/backend && npm install --production --silent"
  ok "Dependencies bijgewerkt."
fi

[[ $UPDATED -eq 0 ]] && { warn "Geen bestanden bijgewerkt."; exit 0; }

# ── Stap 4: Service herstarten ────────────────────────────────────────────────
info "GarageBook herstarten..."
pct exec "$CT_ID" -- systemctl restart garagebook
sleep 3

STATUS=$(pct exec "$CT_ID" -- systemctl is-active garagebook 2>/dev/null || echo "onbekend")
if [[ "$STATUS" == "active" ]]; then
  ok "GarageBook draait — update voltooid! 🏍️"
  echo -e "\n  ${DIM}Commit: ${COMMIT}${NC}"
else
  warn "Service status: ${STATUS}"
  warn "Controleer logs: pct exec ${CT_ID} -- journalctl -u garagebook -n 30"
  exit 1
fi

divider
