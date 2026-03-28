# 🏍️ GarageBook

Digitaal motoronderhoud- en upgradelogboek. Selfhosted op Proxmox LXC.

## Features

- Gebruikersregistratie & login (JWT)
- Meerdere motoren per account
- Onderhoudslogboek met foto's, beschrijvingen en kosten
- Upgrades & parts bijhouden
- Kostenanalyse en tijdlijn
- Automatische dagelijkse backups
- Responsive — werkt op mobiel, tablet en desktop

## Tech stack

| Laag | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Backend | Node.js + Express |
| Database | SQLite (via better-sqlite3) |
| Auth | JWT + bcrypt |
| Hosting | Proxmox LXC — Ubuntu 22.04 |
| Proxy | Nginx (via Nginx Proxy Manager) |

---

## Installatie op Proxmox

### Vereisten
- Proxmox VE 7 of 8
- Root toegang op de Proxmox host
- Internetverbinding vanuit de container

### Stap 1 — Repository klonen op de Proxmox host

```bash
apt-get install -y git
git clone https://github.com/JOUW_GEBRUIKERSNAAM/garagebook.git /root/garagebook-repo
cd /root/garagebook-repo
chmod +x install-garagebook.sh update-from-github.sh update-garagebook.sh
bash install-garagebook.sh
```

---

## Updates uitrollen

### Optie A — Handmatig vanaf de Proxmox host

```bash
GITHUB_REPO=JOUW_GEBRUIKERSNAAM/garagebook bash /root/garagebook-repo/update-from-github.sh 118
```

### Optie B — Automatisch via GitHub Actions

Elke push naar `main` deployt automatisch naar je server.

**1. SSH-sleutelpaar aanmaken op de Proxmox host:**
```bash
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_deploy   # kopieer dit als SECRET
```

**2. Secrets instellen in GitHub:**

Ga naar repo → **Settings** → **Secrets and variables** → **Actions**

| Secret | Waarde |
|---|---|
| `SERVER_HOST` | IP van je Proxmox host |
| `SERVER_USER` | `root` |
| `SERVER_SSH_KEY` | Inhoud van `~/.ssh/github_deploy` |
| `SERVER_PORT` | `22` |
| `CT_ID` | Container ID, bijv. `118` |

**3. Klaar** — elke push naar `main` triggert automatisch een deploy. Handmatig triggeren kan via **Actions** → **Deploy naar server** → **Run workflow**.

---

## Projectstructuur

```
garagebook/
├── backend/
│   ├── server.js
│   └── package.json
├── frontend/
│   └── index.html
├── .github/
│   └── workflows/
│       └── deploy.yml
├── install-garagebook.sh
├── update-from-github.sh
├── update-garagebook.sh
├── .gitignore
└── README.md
```

---

## Beheer

```bash
pct enter 118                                              # shell in container
pct exec 118 -- systemctl status garagebook               # service status
pct exec 118 -- journalctl -u garagebook -f               # live logs
pct exec 118 -- systemctl restart garagebook              # herstarten
pct exec 118 -- garagebook-backup                         # handmatige backup
pct exec 118 -- ls -lh /var/backups/garagebook/           # backups bekijken
```

## Paden in de container

| Pad | Inhoud |
|---|---|
| `/opt/garagebook/` | Applicatiebestanden |
| `/var/lib/garagebook/garagebook.db` | SQLite database |
| `/var/lib/garagebook/uploads/` | Geüploade foto's |
| `/etc/garagebook.env` | JWT secret en poort |
| `/var/backups/garagebook/` | Dagelijkse backups |
