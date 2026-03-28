#!/usr/bin/env bash
# ==============================================================================
#  GarageBook — Proxmox LXC Installatiescript
#  Uitvoeren op de Proxmox HOST als root:
#
#    bash install-garagebook.sh
#
#  Vereisten:
#    - Proxmox VE 7 of 8
#    - Internettoegang vanuit de container
#    - Voor HTTPS: een domein dat al naar het server-IP wijst
# ==============================================================================

set -euo pipefail
IFS=$'\n\t'

# ── Kleurpalet ────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m'
C='\033[0;36m' B='\033[1m' DIM='\033[2m' NC='\033[0m'

header() {
    echo -e "\n${B}${C}┌──────────────────────────────────────────────┐${NC}"
    printf "${B}${C}│  %-44s│${NC}\n" "$*"
    echo -e "${B}${C}└──────────────────────────────────────────────┘${NC}\n"
}
info()    { echo -e "  ${C}→${NC} $*"; }
ok()      { echo -e "  ${G}✓${NC} $*"; }
warn()    { echo -e "  ${Y}!${NC} $*"; }
die()     { echo -e "\n  ${R}✗ FOUT:${NC} $*\n"; exit 1; }
ask()     { echo -en "  ${B}$*${NC} "; }
divider() { echo -e "  ${DIM}────────────────────────────────────────${NC}"; }

# ── Precheck ──────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]]                         && die "Voer dit script uit als root op de Proxmox host."
command -v pveversion &>/dev/null         || die "Niet op een Proxmox VE host gedetecteerd."
command -v pct        &>/dev/null         || die "'pct' niet gevonden. Proxmox tools ontbreken."

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${B}${C}"
cat << 'BANNER'
   ___                         ___            _
  / __|__ _ _ _ __ _ __ _ ___|  _ ) ___  ___| |__
 | (_ / _` | '_/ _` / _` / -_) _ \/ _ \/ _ \ / /
  \___\__,_|_| \__,_\__, \___|___/\___/\___/_\_\
                     |___/
  Proxmox LXC Installatiescript  •  Ubuntu 22.04
BANNER
echo -e "${NC}"

# ==============================================================================
#  STAP 1 — Interactieve configuratie
# ==============================================================================
header "Stap 1 van 8 — Configuratie"

# ── Container ID ──────────────────────────────────────────────────────────────
NEXT_ID=$(pvesh get /cluster/nextid 2>/dev/null || echo "200")
ask "Container ID [${NEXT_ID}]:"
read -r CT_ID
CT_ID="${CT_ID:-$NEXT_ID}"
[[ "$CT_ID" =~ ^[0-9]+$ ]] || die "Container ID moet een getal zijn."

# ── Hostname ──────────────────────────────────────────────────────────────────
ask "Hostname [garagebook]:"
read -r CT_HOSTNAME
CT_HOSTNAME="${CT_HOSTNAME:-garagebook}"

# ── Root wachtwoord ───────────────────────────────────────────────────────────
while true; do
    ask "Root wachtwoord voor de container:"
    read -rsp "" CT_PASSWORD; echo
    ask "Bevestig wachtwoord:"
    read -rsp "" CT_PASSWORD2; echo
    [[ "$CT_PASSWORD" == "$CT_PASSWORD2" ]] && break
    warn "Wachtwoorden komen niet overeen, probeer opnieuw."
done

# ── Storage ───────────────────────────────────────────────────────────────────
echo ""
info "Beschikbare Proxmox storages:"
pvesh get /nodes/$(hostname)/storage --output-format=text 2>/dev/null \
    | grep -E "^\S" | awk '{print "    " $1}' || echo "    (kon lijst niet ophalen)"
ask "Storage naam [local-lvm]:"
read -r CT_STORAGE
CT_STORAGE="${CT_STORAGE:-local-lvm}"

# ── Resources ─────────────────────────────────────────────────────────────────
ask "Schijfgrootte in GB [8]:"
read -r CT_DISK
CT_DISK="${CT_DISK:-8}"

ask "RAM in MB [512]:"
read -r CT_MEMORY
CT_MEMORY="${CT_MEMORY:-512}"

ask "Aantal CPU-cores [1]:"
read -r CT_CORES
CT_CORES="${CT_CORES:-1}"

# ── Netwerk ───────────────────────────────────────────────────────────────────
divider
info "Netwerkconfiguratie"
ask "Network bridge [vmbr0]:"
read -r CT_BRIDGE
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"

ask "IP-adres (bijv. 192.168.1.50/24) of 'dhcp' [dhcp]:"
read -r CT_IP
CT_IP="${CT_IP:-dhcp}"

CT_GW=""
if [[ "$CT_IP" != "dhcp" ]]; then
    ask "Gateway (verplicht bij statisch IP):"
    read -r CT_GW
    [[ -z "$CT_GW" ]] && die "Gateway is verplicht bij een statisch IP-adres."
fi

# ── GarageBook poort ──────────────────────────────────────────────────────────
divider
ask "Interne app-poort [3000]:"
read -r GB_PORT
GB_PORT="${GB_PORT:-3000}"

# ── HTTPS / Let's Encrypt ─────────────────────────────────────────────────────
ask "Wil je HTTPS instellen met Let's Encrypt? (j/n) [n]:"
read -r DO_HTTPS
DO_HTTPS="${DO_HTTPS:-n}"

GB_DOMAIN=""
LE_EMAIL=""
if [[ "${DO_HTTPS,,}" == "j" ]]; then
    echo ""
    warn "Zorg dat het domein al naar het IP van deze server wijst (DNS A-record)."
    warn "Poort 80 en 443 moeten bereikbaar zijn vanaf internet."
    echo ""
    ask "Domeinnaam (bijv. garagebook.jouwdomein.nl):"
    read -r GB_DOMAIN
    [[ -z "$GB_DOMAIN" ]] && die "Domeinnaam is verplicht voor HTTPS."
    ask "E-mailadres voor Let's Encrypt meldingen:"
    read -r LE_EMAIL
    [[ -z "$LE_EMAIL" ]] && die "E-mailadres is verplicht voor Let's Encrypt."
fi

# ── JWT Secret genereren ──────────────────────────────────────────────────────
GB_JWT_SECRET=$(openssl rand -hex 32)

# ── Samenvatting + bevestiging ────────────────────────────────────────────────
divider
echo ""
echo -e "  ${B}Samenvatting:${NC}"
echo -e "  ${DIM}Container ID   :${NC} ${C}${CT_ID}${NC}"
echo -e "  ${DIM}Hostname       :${NC} ${C}${CT_HOSTNAME}${NC}"
echo -e "  ${DIM}Storage        :${NC} ${C}${CT_STORAGE}${NC} — ${CT_DISK}GB schijf"
echo -e "  ${DIM}Resources      :${NC} ${C}${CT_MEMORY}MB RAM, ${CT_CORES} core(s)${NC}"
echo -e "  ${DIM}Netwerk        :${NC} ${C}${CT_BRIDGE}${NC} — IP: ${C}${CT_IP}${NC}"
[[ -n "$CT_GW" ]] && \
echo -e "  ${DIM}Gateway        :${NC} ${C}${CT_GW}${NC}"
echo -e "  ${DIM}App poort      :${NC} ${C}${GB_PORT}${NC}"
if [[ "${DO_HTTPS,,}" == "j" ]]; then
echo -e "  ${DIM}HTTPS domein   :${NC} ${C}${GB_DOMAIN}${NC}"
echo -e "  ${DIM}Let's Encrypt  :${NC} ${C}${LE_EMAIL}${NC}"
else
echo -e "  ${DIM}HTTPS          :${NC} ${DIM}niet ingesteld${NC}"
fi
echo -e "  ${DIM}Backups        :${NC} ${C}dagelijks 03:00, 14 dagen bewaard${NC}"
echo ""
ask "Alles correct? Doorgaan met installatie? (j/n):"
read -r CONFIRM
[[ "${CONFIRM,,}" != "j" ]] && { echo -e "\n  Geannuleerd."; exit 0; }

# ==============================================================================
#  STAP 2 — Ubuntu 22.04 template
# ==============================================================================
header "Stap 2 van 8 — Ubuntu 22.04 template"

# Zoek bestaande Ubuntu 22.04 template
TEMPLATE_FILE=$(find /var/lib/vz/template/cache/ -name "ubuntu-22.04-standard_*.tar.*" 2>/dev/null | sort -V | tail -1 || true)

if [[ -n "$TEMPLATE_FILE" ]]; then
    ok "Template al aanwezig: $(basename "$TEMPLATE_FILE")"
else
    info "Template downloaden via pveam..."
    pveam update &>/dev/null || warn "pveam update mislukt (mogelijk geen internet). Probeer toch..."
    # Probeer te downloaden
    AVAILABLE=$(pveam available --section system 2>/dev/null | grep "ubuntu-22.04-standard" | awk '{print $2}' | sort -V | tail -1 || true)
    if [[ -z "$AVAILABLE" ]]; then
        die "Geen Ubuntu 22.04 template gevonden via pveam. Controleer internetverbinding."
    fi
    info "Downloaden: $AVAILABLE"
    pveam download local "$AVAILABLE"
    TEMPLATE_FILE=$(find /var/lib/vz/template/cache/ -name "ubuntu-22.04-standard_*.tar.*" | sort -V | tail -1)
    ok "Template gedownload: $(basename "$TEMPLATE_FILE")"
fi

TEMPLATE_BASENAME=$(basename "$TEMPLATE_FILE")

# ==============================================================================
#  STAP 3 — LXC container aanmaken
# ==============================================================================
header "Stap 3 van 8 — LXC container aanmaken (CT ${CT_ID})"

# Netwerk argument opbouwen
if [[ "$CT_IP" == "dhcp" ]]; then
    NET_ARG="name=eth0,bridge=${CT_BRIDGE},ip=dhcp,ip6=auto"
else
    NET_ARG="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP},gw=${CT_GW}"
fi

# ── Controleer of container ID al bestaat ────────────────────────────────────
if pct status "$CT_ID" &>/dev/null; then
    EXISTING_STATUS=$(pct status "$CT_ID" | awk '{print $2}')
    warn "Container ${CT_ID} bestaat al (status: ${EXISTING_STATUS})."
    ask "Verwijderen en opnieuw aanmaken? (j/n):"
    read -r REMOVE_EXISTING
    if [[ "${REMOVE_EXISTING,,}" == "j" ]]; then
        if [[ "$EXISTING_STATUS" == "running" ]]; then
            info "Container stoppen..."
            pct stop "$CT_ID"
            sleep 3
        fi
        info "Container ${CT_ID} verwijderen..."
        pct destroy "$CT_ID" --force 1
        ok "Container verwijderd."
    else
        die "Kies een ander container ID of verwijder CT ${CT_ID} handmatig:\n  pct destroy ${CT_ID} --force 1"
    fi
fi

info "Container aanmaken..."
pct create "$CT_ID" "local:vztmpl/${TEMPLATE_BASENAME}" \
    --hostname    "$CT_HOSTNAME"                \
    --password    "$CT_PASSWORD"                \
    --storage     "$CT_STORAGE"                 \
    --rootfs      "${CT_STORAGE}:${CT_DISK}"    \
    --memory      "$CT_MEMORY"                  \
    --swap        512                           \
    --cores       "$CT_CORES"                   \
    --net0        "$NET_ARG"                    \
    --unprivileged 1                            \
    --features    nesting=1                     \
    --onboot      1                             \
    --ostype      ubuntu                        \
    --start       0
ok "Container ${CT_ID} aangemaakt."

info "Container starten..."
pct start "$CT_ID"

# ── Stap 1: wacht tot de container-init klaar is (systemd ready) ──────────────
info "Wachten tot container volledig opgestart is..."
for i in {1..30}; do
    if pct exec "$CT_ID" -- bash -c "true" &>/dev/null; then
        break
    fi
    sleep 2
    [[ $i -eq 30 ]] && die "Container reageert na 60s niet. Controleer: pct status ${CT_ID}"
done
ok "Container reageert."

# ── Stap 2: wacht op een IP-adres (DHCP kan even duren) ──────────────────────
info "Wachten op IP-adres (DHCP)..."
for i in {1..20}; do
    CT_IP_ACTUAL=$(pct exec "$CT_ID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)
    if [[ -n "$CT_IP_ACTUAL" && "$CT_IP_ACTUAL" != "127.0.0.1" ]]; then
        ok "IP-adres ontvangen: ${B}${CT_IP_ACTUAL}${NC}"
        break
    fi
    sleep 3
    [[ $i -eq 20 ]] && {
        warn "Geen IP-adres ontvangen na 60s."
        warn "Mogelijke oorzaken:"
        warn "  • Bridge ${CT_BRIDGE} bestaat niet of heeft geen DHCP-server"
        warn "  • Controleer: pvesh get /nodes/\$(hostname)/network"
        warn "  • Handmatig instellen: pct set ${CT_ID} --net0 name=eth0,bridge=vmbr0,ip=dhcp"
        die "Geen netwerk. Pas de netwerkinstellingen aan en herstart het script."
    }
done

# ── Stap 3: wacht op internettoegang (ping, set -e tijdelijk uit) ─────────────
info "Wachten op internettoegang..."
INET_OK=0
for i in {1..25}; do
    # set -e tijdelijk uit zodat een mislukte ping het script niet afbreekt
    if pct exec "$CT_ID" -- bash -c "ping -c1 -W3 8.8.8.8" &>/dev/null ||        pct exec "$CT_ID" -- bash -c "ping -c1 -W3 1.1.1.1" &>/dev/null; then
        ok "Internet bereikbaar (na $((i*3))s)."
        INET_OK=1
        break
    fi
    echo -en "  ${DIM}  poging ${i}/25...\r${NC}"
    sleep 3
done
echo ""
if [[ $INET_OK -eq 0 ]]; then
    warn "Container heeft IP ${CT_IP_ACTUAL} maar geen internettoegang na 75s."
    warn "Veelvoorkomende oorzaken:"
    warn "  • DHCP-server geeft geen gateway mee"
    warn "  • Bridge ${CT_BRIDGE} heeft geen uplink naar buiten"
    warn "  • IP-masquerading (NAT) niet actief op de Proxmox host"
    warn ""
    warn "Controleer op de Proxmox host:"
    warn "  iptables -t nat -L POSTROUTING -n"
    warn "  cat /proc/sys/net/ipv4/ip_forward  (moet 1 zijn)"
    warn ""
    warn "Of stel handmatig een statisch IP + gateway in en herstart:"
    warn "  pct set ${CT_ID} --net0 name=eth0,bridge=${CT_BRIDGE},ip=x.x.x.x/24,gw=x.x.x.1"
    die "Geen internettoegang. Los bovenstaande problemen op en herstart het script."
fi

# ==============================================================================
#  STAP 4 — Basissysteem
# ==============================================================================
header "Stap 4 van 8 — Systeem updaten & basis installeren"

pct exec "$CT_ID" -- bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get upgrade -y -qq 2>/dev/null
    apt-get install -y -qq \
        curl wget ca-certificates gnupg lsb-release \
        openssl sqlite3 cron logrotate 2>/dev/null
" && ok "Systeem bijgewerkt en basispakketten geïnstalleerd."

# ==============================================================================
#  STAP 5 — Node.js 20
# ==============================================================================
header "Stap 5 van 8 — Node.js 20 installeren"

pct exec "$CT_ID" -- bash -c "
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs 2>/dev/null
" 

NODE_VER=$(pct exec "$CT_ID" -- node --version 2>/dev/null || echo "onbekend")
ok "Node.js geïnstalleerd: ${B}${NODE_VER}${NC}"

# ==============================================================================
#  STAP 6 — Nginx + Certbot
# ==============================================================================
header "Stap 6 van 8 — Nginx installeren & configureren"

pct exec "$CT_ID" -- bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq nginx certbot python3-certbot-nginx 2>/dev/null
    systemctl enable nginx --quiet
    systemctl start nginx
"
ok "Nginx geïnstalleerd en gestart."

# Nginx site config schrijven
SERVER_NAME="${GB_DOMAIN:-_}"

pct exec "$CT_ID" -- bash -c "cat > /etc/nginx/sites-available/garagebook << 'NGINXCONF'
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};

    # Gzip compressie
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Upload limiet
    client_max_body_size 10M;

    # Proxy naar Node.js
    location / {
        proxy_pass         http://127.0.0.1:${GB_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
    }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/garagebook /etc/nginx/sites-enabled/garagebook
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx"

ok "Nginx geconfigureerd (site: ${SERVER_NAME})."

# ── Let's Encrypt ─────────────────────────────────────────────────────────────
if [[ "${DO_HTTPS,,}" == "j" && -n "$GB_DOMAIN" ]]; then
    echo ""
    info "Let's Encrypt certificaat aanvragen voor ${B}${GB_DOMAIN}${NC}..."
    info "DNS-check: domein moet wijzen naar ${CT_IP_ACTUAL}"
    echo ""

    # Controleer of het domein al resolvet naar dit IP
    RESOLVED_IP=$(pct exec "$CT_ID" -- bash -c "curl -sf --max-time 5 https://api64.ipify.org 2>/dev/null || echo ''" || echo "")
    if [[ -z "$RESOLVED_IP" ]]; then
        warn "Kon publiek IP niet bepalen. Certbot wordt toch geprobeerd."
    fi

    if pct exec "$CT_ID" -- bash -c "
        certbot --nginx \
            --non-interactive \
            --agree-tos \
            --redirect \
            -m '${LE_EMAIL}' \
            -d '${GB_DOMAIN}' 2>&1
    "; then
        ok "HTTPS actief voor ${B}https://${GB_DOMAIN}${NC}"

        # Auto-renew cron instellen
        pct exec "$CT_ID" -- bash -c "
            echo '0 3 * * * root certbot renew --quiet --nginx' > /etc/cron.d/certbot-renew
            chmod 644 /etc/cron.d/certbot-renew
        "
        ok "Automatische certificaatverlenging ingesteld."
    else
        warn "Let's Encrypt mislukt. Veelvoorkomende oorzaken:"
        warn "  • DNS-record wijst nog niet naar dit server-IP"
        warn "  • Poort 80 niet bereikbaar vanaf internet"
        warn "  • Rate limit overschreden (max 5 pogingen per uur)"
        warn ""
        warn "Handmatig opnieuw proberen (vanuit de container):"
        warn "  pct exec ${CT_ID} -- certbot --nginx -d ${GB_DOMAIN} -m ${LE_EMAIL} --agree-tos"
    fi
fi

# ==============================================================================
#  STAP 7 — GarageBook installeren
# ==============================================================================
header "Stap 7 van 8 — GarageBook installeren"

# ── Mapstructuur ──────────────────────────────────────────────────────────────
pct exec "$CT_ID" -- bash -c "
    mkdir -p /opt/garagebook/{backend,frontend}
    mkdir -p /var/lib/garagebook
    chown -R root:root /opt/garagebook
    chmod 750 /var/lib/garagebook
"
ok "Mappenstructuur aangemaakt."

# ── package.json ──────────────────────────────────────────────────────────────
pct exec "$CT_ID" -- bash -c "cat > /opt/garagebook/backend/package.json << 'PKGJSON'
{
  "name": "garagebook-backend",
  "version": "1.0.0",
  "description": "GarageBook API server",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2"
  }
}
PKGJSON"

# ── server.js ─────────────────────────────────────────────────────────────────
# We schrijven server.js via een Python base64 decode om heredoc-escaping te vermijden
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/backend/server.js" ]]; then
    info "Backend kopiëren vanuit pakket..."
    pct push "$CT_ID" "$SCRIPT_DIR/backend/server.js"  /opt/garagebook/backend/server.js
    ok "server.js gekopieerd."
else
    warn "backend/server.js niet naast het installatiescript gevonden."
    warn "Kopieer het handmatig: pct push ${CT_ID} ./backend/server.js /opt/garagebook/backend/server.js"
fi

# ── frontend ──────────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/frontend/index.html" ]]; then
    info "Frontend kopiëren vanuit pakket..."
    pct push "$CT_ID" "$SCRIPT_DIR/frontend/index.html" /opt/garagebook/frontend/index.html
    ok "index.html gekopieerd."
else
    warn "frontend/index.html niet naast het installatiescript gevonden."
    warn "Kopieer het handmatig: pct push ${CT_ID} ./frontend/index.html /opt/garagebook/frontend/index.html"
fi

# ── npm install ───────────────────────────────────────────────────────────────
info "Node.js dependencies installeren (npm install)..."
pct exec "$CT_ID" -- bash -c "
    cd /opt/garagebook/backend
    npm install --production --silent 2>&1 | tail -3
" && ok "Dependencies geïnstalleerd."

# ── Environment bestand ───────────────────────────────────────────────────────
pct exec "$CT_ID" -- bash -c "cat > /etc/garagebook.env << ENVFILE
# GarageBook omgevingsvariabelen
# Bewerk dit bestand en herstart de service: systemctl restart garagebook

PORT=${GB_PORT}
NODE_ENV=production
JWT_SECRET=${GB_JWT_SECRET}
DATA_DIR=/var/lib/garagebook
ENVFILE
chmod 600 /etc/garagebook.env"
ok "Omgevingsvariabelen opgeslagen in /etc/garagebook.env"

# ── Systemd service ───────────────────────────────────────────────────────────
pct exec "$CT_ID" -- bash -c "cat > /etc/systemd/system/garagebook.service << 'SVCFILE'
[Unit]
Description=GarageBook — Motoronderhoud & Upgrades
Documentation=https://github.com/yourusername/garagebook
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/garagebook/backend
EnvironmentFile=/etc/garagebook.env
ExecStart=/usr/bin/node /opt/garagebook/backend/server.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=garagebook

[Install]
WantedBy=multi-user.target
SVCFILE"

pct exec "$CT_ID" -- bash -c "
    systemctl daemon-reload
    systemctl enable garagebook --quiet
    systemctl start garagebook
"
sleep 3

# Health check
if pct exec "$CT_ID" -- bash -c "curl -sf --max-time 5 http://127.0.0.1:${GB_PORT}/ > /dev/null 2>&1"; then
    ok "GarageBook service draait correct op poort ${GB_PORT}."
else
    warn "Service gestart maar reageert nog niet op HTTP. Controleer met:"
    warn "  pct exec ${CT_ID} -- journalctl -u garagebook -n 30"
fi

# ── Logrotate ─────────────────────────────────────────────────────────────────
pct exec "$CT_ID" -- bash -c "cat > /etc/logrotate.d/garagebook << 'LOGROTATE'
/var/log/garagebook*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    create 640 root root
}
LOGROTATE"

# ==============================================================================
#  STAP 8 — Automatische backups
# ==============================================================================
header "Stap 8 van 8 — Automatische backups"

pct exec "$CT_ID" -- bash -c "
mkdir -p /var/backups/garagebook

cat > /usr/local/bin/garagebook-backup << 'BACKUPSCRIPT'
#!/usr/bin/env bash
# GarageBook dagelijkse backup
set -euo pipefail

DB_SRC=\"/var/lib/garagebook/garagebook.db\"
BACKUP_DIR=\"/var/backups/garagebook\"
DATE=\"\$(date +%Y-%m-%d_%H%M%S)\"
DEST=\"\${BACKUP_DIR}/garagebook_\${DATE}.db\"
KEEP=14

# Database bestaat nog niet als nog niemand ingelogd is
if [[ ! -f \"\$DB_SRC\" ]]; then
    echo \"\$(date '+%Y-%m-%d %H:%M:%S') [SKIP] Database nog niet aanwezig.\"
    exit 0
fi

# SQLite hot backup (veilig tijdens gebruik)
sqlite3 \"\$DB_SRC\" \".backup '\$DEST'\"
gzip -9 \"\$DEST\"

# Opschonen — houd max \$KEEP backups
mapfile -t OLD < <(ls -tp \"\$BACKUP_DIR\"/garagebook_*.db.gz 2>/dev/null | tail -n +\$((KEEP+1)))
for f in \"\${OLD[@]:-}\"; do [[ -f \"\$f\" ]] && rm \"\$f\"; done

SIZE=\$(du -sh \"\${DEST}.gz\" 2>/dev/null | cut -f1 || echo '?')
echo \"\$(date '+%Y-%m-%d %H:%M:%S') [OK] Backup: \${DEST}.gz (\${SIZE})\"
BACKUPSCRIPT

chmod +x /usr/local/bin/garagebook-backup

# Cron: dagelijks om 03:00
cat > /etc/cron.d/garagebook-backup << 'CRONFILE'
# GarageBook dagelijkse database backup
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 3 * * * root /usr/local/bin/garagebook-backup >> /var/log/garagebook-backup.log 2>&1
CRONFILE
chmod 644 /etc/cron.d/garagebook-backup

# Eerste backup direct aanmaken (database bestaat misschien nog niet, dat is OK)
/usr/local/bin/garagebook-backup || true

echo 'Backup systeem gereed.'
" && ok "Automatische dagelijkse backup geconfigureerd (03:00, ${B}14 dagen${NC} bewaard)."

# ==============================================================================
#  KLAAR — Eindrapport
# ==============================================================================

echo ""
echo -e "${B}${G}"
cat << 'DONE'
  ╔══════════════════════════════════════════════╗
  ║   ✓  Installatie succesvol afgerond!  🏍️    ║
  ╚══════════════════════════════════════════════╝
DONE
echo -e "${NC}"

# URL bepalen
if [[ "${DO_HTTPS,,}" == "j" && -n "$GB_DOMAIN" ]]; then
    GBURL="https://${GB_DOMAIN}"
elif [[ -n "$GB_DOMAIN" ]]; then
    GBURL="http://${GB_DOMAIN}"
else
    GBURL="http://${CT_IP_ACTUAL}"
fi

echo -e "  ${B}GarageBook bereikbaar via:${NC}"
echo -e "  ${G}${B}${GBURL}${NC}"
[[ "$CT_IP_ACTUAL" != "onbekend" && -z "$GB_DOMAIN" ]] || \
echo -e "  ${DIM}(ook via http://${CT_IP_ACTUAL} als fallback)${NC}"

echo ""
echo -e "  ${B}Container beheer (uitvoeren op Proxmox host):${NC}"
echo -e "  ${DIM}Shell openen     :${NC}  pct enter ${CT_ID}"
echo -e "  ${DIM}Service status   :${NC}  pct exec ${CT_ID} -- systemctl status garagebook"
echo -e "  ${DIM}Live logs        :${NC}  pct exec ${CT_ID} -- journalctl -u garagebook -f"
echo -e "  ${DIM}Herstarten       :${NC}  pct exec ${CT_ID} -- systemctl restart garagebook"
echo -e "  ${DIM}Handm. backup    :${NC}  pct exec ${CT_ID} -- garagebook-backup"
echo -e "  ${DIM}Backups bekijken :${NC}  pct exec ${CT_ID} -- ls -lh /var/backups/garagebook/"
echo ""
echo -e "  ${B}JWT Secret${NC} ${DIM}(bewaar dit op een veilige plek!):${NC}"
echo -e "  ${Y}${GB_JWT_SECRET}${NC}"
echo -e "  ${DIM}Opgeslagen in container: /etc/garagebook.env${NC}"
echo ""
if [[ "${DO_HTTPS,,}" != "j" ]]; then
    echo -e "  ${Y}TIP:${NC} HTTPS later activeren:"
    echo -e "  ${DIM}pct exec ${CT_ID} -- certbot --nginx -d jouwdomein.nl -m jouw@email.nl --agree-tos${NC}"
    echo ""
fi
echo -e "  ${DIM}Installatielog: /var/log op de Proxmox host${NC}"
divider
echo ""
