# 🏍️ GarageBook

> **Digitaal motoronderhoud- en upgradelogboek** — selfhosted op Proxmox LXC, bereikbaar via je eigen domein.

GarageBook helpt je het complete verhaal van je motor vast te leggen: onderhoudsbeurten, upgrades, kosten, foto's en herinneringen — allemaal op één plek, voor meerdere gebruikers en meerdere motoren.

## 📸 Schermafbeeldingen

![Dashboard](docs/afbeelding1.png)

![Onderhoudslogboek](docs/afbeelding2.png)

![Herinneringen & AI](docs/afbeelding3.png)

---

## ✨ Features

| Feature | Beschrijving |
|---|---|
| 👤 **Gebruikersaccounts** | Registreren met e-mail + wachtwoord, JWT-sessies van 7 dagen |
| 🏍️ **Multi-motor** | Onbeperkt motoren per account, elk met eigen logboek |
| 📋 **Onderhoudslogboek** | Beurten, reparaties, inspecties en vloeistoffen bijhouden |
| ⭐ **Upgrades & Parts** | Modificaties en onderdelen met merk, categorie en kosten |
| 📷 **Foto's** | Foto uploaden per logboek-item of upgrade (max 8MB) |
| 🔔 **Herinneringen** | Op km-stand, datum of beide — met voortgangsbalk en herhaling |
| 🤖 **AI intervallen** | Automatisch officiële onderhoudsintervallen opzoeken via AI + web search |
| 📊 **Statistieken** | Kosten per jaar, per categorie, per km en per maand |
| 🔗 **Deellink** | Motor read-only delen met derden, geen account nodig |
| 📄 **PDF export** | Volledige logboek afdrukken via de browser |
| 🌙 **Donkere modus** | Volgt systeemvoorkeur, handmatig te togglen |
| 📱 **PWA** | Installeerbaar als app op iPhone en Android |
| ↕️ **Sorteren** | Logboek en upgrades sorteren op datum, kosten of km |
| 🔍 **Lightbox** | Foto's vergroten door erop te klikken |
| 🔢 **Versienummer** | Altijd zichtbaar in de topbar — handig na updates |

---

## 🛠️ Tech stack

| Laag | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (één bestand, geen build stap) |
| Backend | Node.js + Express |
| Database | SQLite via better-sqlite3 |
| Auth | JWT + bcrypt |
| Foto's | Multer — opgeslagen op schijf |
| AI | Anthropic Claude Haiku + web search |
| Hosting | Proxmox LXC — Ubuntu 22.04 |
| Proxy | Nginx Proxy Manager |
| HTTPS | Let's Encrypt via Cloudflare |

---

## 🚀 Installatie op Proxmox

### Vereisten
- Proxmox VE 7 of 8, root toegang
- Internetverbinding vanuit de container

```bash
# Repository klonen op de Proxmox host
apt-get install -y git
git clone https://github.com/JOUW_NAAM/garagebook.git /root/garagebook-repo
cd /root/garagebook-repo
chmod +x install-garagebook.sh update-from-github.sh
bash install-garagebook.sh
```

Het script vraagt interactief om container ID, netwerk, opslag, domein en HTTPS.

---

## 🔄 Updates uitrollen

```bash
# Vanuit container 118 (na eenmalige setup)
garagebook-update
```

Of handmatig:
```bash
GITHUB_REPO=JOUW_NAAM/garagebook bash /root/garagebook-repo/update-from-github.sh 118
```

---

## 🤖 AI Onderhoudsintervallen instellen

De AI-functie gebruikt Claude Haiku met web search om officiële onderhoudsintervallen op te zoeken.

**Stap 1** — API key aanmaken op [console.anthropic.com](https://console.anthropic.com)
- Gratis tegoed van $5 bij registratie
- Claude Haiku kost ~$0.001 per zoekopdracht (centen per maand)

**Stap 2** — Key instellen in de container:
```bash
pct enter 118
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> /etc/garagebook.env
systemctl restart garagebook
```

**Stap 3** — Gebruik:
- **Bij nieuwe motor**: "Volgende — AI herinneringen →" in de tweede stap
- **Bij bestaande motor**: Herinneringen tab → "🤖 AI intervallen importeren"

> Zonder API key werkt de knop ook — dan worden generieke motorfiets-intervallen gebruikt als fallback.

---

## 🔧 Beheer

```bash
pct enter 118                                    # Shell in container
pct exec 118 -- systemctl status garagebook      # Service status
pct exec 118 -- journalctl -u garagebook -f      # Live logs
pct exec 118 -- systemctl restart garagebook     # Herstarten
pct exec 118 -- garagebook-backup               # Handmatige backup
pct exec 118 -- ls -lh /var/backups/garagebook/ # Backups bekijken
pct exec 118 -- cat /etc/garagebook.env         # Instellingen bekijken
```

### Paden in de container

| Pad | Inhoud |
|---|---|
| `/opt/garagebook/` | Applicatiebestanden |
| `/var/lib/garagebook/garagebook.db` | SQLite database |
| `/var/lib/garagebook/uploads/` | Geüploade foto's |
| `/etc/garagebook.env` | JWT secret, poort, API keys |
| `/var/backups/garagebook/` | Dagelijkse backups (14 dagen) |

---

## 🗺️ API Overzicht

<details>
<summary>Alle endpoints uitklappen</summary>

| Method | Route | Auth | Beschrijving |
|---|---|---|---|
| POST | `/api/auth/register` | — | Account aanmaken |
| POST | `/api/auth/login` | — | Inloggen |
| GET | `/api/auth/me` | ✓ | Huidige gebruiker |
| GET | `/api/bikes` | ✓ | Alle motoren |
| POST | `/api/bikes` | ✓ | Motor toevoegen |
| PUT | `/api/bikes/:id` | ✓ | Motor aanpassen |
| DELETE | `/api/bikes/:id` | ✓ | Motor verwijderen |
| POST | `/api/bikes/:id/share` | ✓ | Deellink aanmaken |
| DELETE | `/api/bikes/:id/share` | ✓ | Deellink verwijderen |
| GET | `/api/share/:token` | — | Publieke read-only data |
| GET | `/api/bikes/:id/logboek` | ✓ | Logboek ophalen |
| POST | `/api/bikes/:id/logboek` | ✓ | Item toevoegen |
| PUT | `/api/bikes/:id/logboek/:id` | ✓ | Item aanpassen |
| DELETE | `/api/bikes/:id/logboek/:id` | ✓ | Item verwijderen |
| GET | `/api/bikes/:id/upgrades` | ✓ | Upgrades ophalen |
| POST | `/api/bikes/:id/upgrades` | ✓ | Upgrade toevoegen |
| PUT | `/api/bikes/:id/upgrades/:id` | ✓ | Upgrade aanpassen |
| DELETE | `/api/bikes/:id/upgrades/:id` | ✓ | Upgrade verwijderen |
| GET | `/api/bikes/:id/herinneringen` | ✓ | Herinneringen ophalen |
| POST | `/api/bikes/:id/herinneringen` | ✓ | Herinnering toevoegen |
| PUT | `/api/bikes/:id/herinneringen/:id` | ✓ | Herinnering aanpassen |
| DELETE | `/api/bikes/:id/herinneringen/:id` | ✓ | Herinnering verwijderen |
| POST | `/api/ai/onderhoudsintervallen` | ✓ | AI intervallen opzoeken |
| POST | `/api/upload` | ✓ | Foto uploaden |
| GET | `/api/version` | — | Versienummer |

</details>

---

## 💡 Ideeën voor toekomstige uitbreidingen

### Praktisch & nuttig
- **📊 Brandstofverbruik** — tankbeurten bijhouden met liters, prijs en verbruik per 100 km
- **🔎 Zoekfunctie** — zoeken door logboek en upgrades op trefwoord
- **📅 Kalenderweergave** — onderhoud en herinneringen op een kalender
- **🏷️ Tags / labels** — eigen labels toevoegen aan items voor betere filtering
- **📎 Documenten** — PDF bijlagen toevoegen (facturen, garantiebewijzen, APK-rapporten)

### Meerdere gebruikers
- **👥 Motor delen met schrijftoegang** — een monteur of mederijder toegang geven
- **🏢 Garagebeheer** — meerdere klanten en motoren voor een werkplaats
- **💬 Notities per item** — opmerkingen toevoegen per logboekregel

### Integraties
- **📧 E-mailmeldingen** — herinnering per e-mail als grens bijna bereikt is
- **📲 Push notificaties** — via PWA of Telegram bot
- **🗺️ Ritten bijhouden** — routes en afstanden loggen via GPS
- **🔌 OBD2 koppeling** — automatisch km-stand uitlezen via Bluetooth OBD2 dongle
- **📦 Onderdelenlijst** — voorraad van reserveonderdelen bijhouden

### Waardebepaling
- **💰 Aankoopwaarde vs. investeringen** — wat heeft de motor gekost, wat heb je erin gestopt
- **📈 Waarderapport** — exporteerbaar overzicht voor verkoop of verzekering
- **🏆 Kilometerhistorie** — grafiek van km-stand over tijd

---

## 📁 Projectstructuur

```
garagebook/
├── backend/
│   ├── server.js           # Express API — alle endpoints
│   └── package.json
├── frontend/
│   ├── index.html          # Volledige SPA — HTML + CSS + JS
│   └── manifest.json       # PWA configuratie
├── .github/
│   └── workflows/
│       └── deploy.yml      # Automatische deploy bij git push
├── install-garagebook.sh   # Eerste installatie op Proxmox
├── update-from-github.sh   # Updaten vanuit GitHub
├── update-garagebook.sh    # Lokale update
├── .gitignore
└── README.md
```

---

## 📋 Versiehistorie

| Versie | Wat |
|---|---|
| **v2.3.1** | AI intervallen importeren voor bestaande motoren |
| **v2.3.0** | AI onderhoudsintervallen bij motor toevoegen (Claude + web search) |
| **v2.2.0** | Herinneringen, statistieken, deellink, PDF, donkere modus, PWA, sorteren |
| **v2.1.0** | Versienummer in topbar en paginatitel |
| **v2.0.0** | Foto upload, aanpassen knop, notitiesveld, kaartdesign |
| **v1.0.0** | Eerste versie — auth, multi-motor, logboek, upgrades, kostenanalyse |

---

*Gebouwd met ❤️ voor motorrijders die grip willen houden op hun machine.*
