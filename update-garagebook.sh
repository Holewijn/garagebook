#!/usr/bin/env bash
# ==============================================================================
#  GarageBook — Update script
#  Gebruik: bash update-garagebook.sh [CT_ID]
#  Uitvoeren op de Proxmox host als root.
# ==============================================================================

set -euo pipefail

R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' B='\033[1m' NC='\033[0m'
ok()   { echo -e "  ${G}✓${NC} $*"; }
info() { echo -e "  ${C}→${NC} $*"; }
warn() { echo -e "  ${Y}!${NC} $*"; }
die()  { echo -e "\n  ${R}✗ FOUT:${NC} $*\n"; exit 1; }

[[ $EUID -ne 0 ]] && die "Voer dit script uit als root op de Proxmox host."
command -v pct &>/dev/null || die "pct niet gevonden. Niet op een Proxmox host?"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Container ID bepalen
CT_ID="${1:-}"
if [[ -z "$CT_ID" ]]; then
    echo -e "\n  ${B}Draaiende containers:${NC}"
    pct list | grep running | awk '{printf "    ID %-6s  %s\n", $1, $3}' || true
    echo ""
    read -rp "  Container ID: " CT_ID
fi

[[ -z "$CT_ID" ]] && die "Geen container ID opgegeven."
pct status "$CT_ID" &>/dev/null || die "Container ${CT_ID} niet gevonden."

CT_STATUS=$(pct status "$CT_ID" | awk '{print $2}')
[[ "$CT_STATUS" != "running" ]] && die "Container ${CT_ID} is niet actief (status: ${CT_STATUS})."

echo -e "\n${B}${C}══ GarageBook update → CT ${CT_ID} ══${NC}\n"

# Backup vóór update
info "Backup aanmaken vóór update..."
pct exec "$CT_ID" -- bash -c "
    if [[ -x /usr/local/bin/garagebook-backup ]]; then
        /usr/local/bin/garagebook-backup
    else
        echo 'Backup script niet gevonden, overslaan.'
    fi
" && ok "Backup aangemaakt."

UPDATED=0

# Frontend updaten
if [[ -f "$SCRIPT_DIR/frontend/index.html" ]]; then
    info "Frontend updaten..."
    pct push "$CT_ID" "$SCRIPT_DIR/frontend/index.html" /opt/garagebook/frontend/index.html
    ok "Frontend bijgewerkt."
    UPDATED=1
else
    warn "frontend/index.html niet gevonden naast dit script — overgeslagen."
fi

# Backend updaten
if [[ -f "$SCRIPT_DIR/backend/server.js" ]]; then
    info "Backend updaten..."
    pct push "$CT_ID" "$SCRIPT_DIR/backend/server.js" /opt/garagebook/backend/server.js
    ok "Backend bijgewerkt."
    UPDATED=1
else
    warn "backend/server.js niet gevonden naast dit script — overgeslagen."
fi

# npm install na backend update
if [[ -f "$SCRIPT_DIR/backend/package.json" ]]; then
    info "package.json updaten en dependencies controleren..."
    pct push "$CT_ID" "$SCRIPT_DIR/backend/package.json" /opt/garagebook/backend/package.json
    pct exec "$CT_ID" -- bash -c "cd /opt/garagebook/backend && npm install --production --silent"
    ok "Dependencies bijgewerkt."
fi

if [[ $UPDATED -eq 0 ]]; then
    warn "Geen bestanden bijgewerkt. Zorg dat backend/ en frontend/ naast dit script staan."
    exit 0
fi

# Service herstarten
info "GarageBook herstarten..."
pct exec "$CT_ID" -- systemctl restart garagebook
sleep 3

STATUS=$(pct exec "$CT_ID" -- systemctl is-active garagebook 2>/dev/null || echo "onbekend")
if [[ "$STATUS" == "active" ]]; then
    ok "GarageBook draait — update voltooid! 🏍️"
else
    warn "Service status: ${STATUS}"
    warn "Controleer logs: pct exec ${CT_ID} -- journalctl -u garagebook -n 50"
fi

echo ""
