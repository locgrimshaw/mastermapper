"""
pipeline/build_agent_rents.py
-----------------------------
Curates data/agent_office_rents_raw.json (one row per agent x zone x tier
figure, harvested from the agents' PUBLIC research each quarter) into
data/agent_office_rents.json — the zone file the database loader
(load_agent_office_rents) serves to the map's "Headline office rents
(agent consensus)" layer.

What it does:
  * maps each source's own submarket naming onto a canonical zone via the
    ALIASES table (agents disagree about where "Midtown" ends — the
    gazetteer is the editorial decision, revisit it when adding sources);
  * drops region-scale aggregates (SKIP) that would blur a zone consensus;
  * de-duplicates per (zone, tier, agent), keeping the most recent period,
    so one agent's June and Q2 figures don't both count in the average;
  * computes the per-tier consensus = simple mean of the surviving figures.

Quarterly refresh: update the raw file's figures (docs/MANUAL_TASKS.md has
the source list), run this, commit both JSONs, push, re-run the loader.
"""

import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "agent_office_rents_raw.json"
OUT = ROOT / "data" / "agent_office_rents.json"

# zone -> (lng, lat, region)
ZONES = {
    # Central London — West End
    "Mayfair & St James's": (-0.1445, 51.5085, "London — West End"),
    "West End (overall)": (-0.140, 51.5120, "London — West End"),
    "Soho & Leicester Square": (-0.1320, 51.5135, "London — West End"),
    "Fitzrovia": (-0.1380, 51.5180, "London — West End"),
    "North of Oxford Street": (-0.1470, 51.5165, "London — West End"),
    "Marylebone": (-0.1520, 51.5185, "London — West End"),
    "Euston": (-0.1320, 51.5260, "London — West End"),
    "Victoria & Westminster": (-0.1380, 51.4970, "London — West End"),
    "Knightsbridge": (-0.1630, 51.5000, "London — West End"),
    "Chelsea": (-0.1690, 51.4900, "London — West End"),
    "Kensington & South Kensington": (-0.1760, 51.4960, "London — West End"),
    "Paddington": (-0.1760, 51.5160, "London — West End"),
    # Central London — Midtown & City
    "Covent Garden & Strand": (-0.1220, 51.5120, "London — Midtown"),
    "Bloomsbury": (-0.1270, 51.5200, "London — Midtown"),
    "Midtown / Holborn": (-0.1150, 51.5170, "London — Midtown"),
    "King's Cross": (-0.1240, 51.5310, "London — Midtown"),
    "City Core": (-0.0860, 51.5145, "London — City"),
    "City Secondary (Blackfriars / Aldgate)": (-0.0950, 51.5120, "London — City"),
    "Clerkenwell & Farringdon": (-0.1050, 51.5210, "London — City fringe"),
    "Shoreditch": (-0.0780, 51.5240, "London — City fringe"),
    "Spitalfields": (-0.0750, 51.5190, "London — City fringe"),
    "Aldgate & Whitechapel": (-0.0660, 51.5150, "London — City fringe"),
    "Southbank": (-0.1040, 51.5050, "London — Southbank"),
    # London — East
    "Canary Wharf": (-0.0190, 51.5050, "London — East"),
    "Rest of Docklands / Crossharbour": (-0.0210, 51.4950, "London — East"),
    "Stratford": (-0.0040, 51.5430, "London — East"),
    "Royal Docks": (0.0300, 51.5080, "London — East"),
    "Barking & Dagenham": (0.1150, 51.5350, "London — East"),
    "Romford": (0.1820, 51.5760, "London — East"),
    # London — West / South / North
    "White City": (-0.2250, 51.5120, "London — West"),
    "Hammersmith": (-0.2230, 51.4930, "London — West"),
    "Chiswick": (-0.2570, 51.4920, "London — West"),
    "Ealing": (-0.3020, 51.5130, "London — West"),
    "Olympia": (-0.2100, 51.4960, "London — West"),
    "Battersea & Nine Elms": (-0.1350, 51.4800, "London — South"),
    "Richmond": (-0.3010, 51.4610, "London — South West"),
    "South West London (Wimbledon)": (-0.2060, 51.4210, "London — South West"),
    "Croydon": (-0.1000, 51.3730, "London — South"),
    "Bromley": (0.0170, 51.4050, "London — South East"),
    "Greenwich": (0.0050, 51.4800, "London — South East"),
    "Enfield": (-0.0820, 51.6520, "London — North"),
    # Thames Valley / M25 West
    "Reading": (-0.9710, 51.4550, "Thames Valley"),
    "Maidenhead": (-0.7200, 51.5220, "Thames Valley"),
    "Slough": (-0.5910, 51.5110, "Thames Valley"),
    "Bracknell": (-0.7520, 51.4160, "Thames Valley"),
    "Uxbridge": (-0.4780, 51.5460, "M25 West"),
    "Heathrow & Stockley Park": (-0.4460, 51.4870, "M25 West"),
    "Staines": (-0.5130, 51.4340, "M25 West"),
    # Surrey / Hampshire
    "Guildford": (-0.5740, 51.2360, "Surrey"),
    "Woking": (-0.5580, 51.3190, "Surrey"),
    "Weybridge": (-0.4530, 51.3720, "Surrey"),
    "Chertsey": (-0.5080, 51.3900, "Surrey"),
    "Leatherhead": (-0.3300, 51.2950, "Surrey"),
    "Redhill": (-0.1690, 51.2400, "Surrey"),
    "Reigate": (-0.2060, 51.2370, "Surrey"),
    "Camberley": (-0.7440, 51.3380, "Surrey"),
    "Farnborough": (-0.7530, 51.2940, "Hampshire"),
    "Fleet": (-0.8430, 51.2800, "Hampshire"),
    "Hook": (-0.9640, 51.2790, "Hampshire"),
    "Basingstoke": (-1.0880, 51.2630, "Hampshire"),
    "Southampton": (-1.4040, 50.9060, "South Coast"),
    "Portsmouth": (-1.0910, 50.8050, "South Coast"),
    "Solent Business Park": (-1.2430, 50.8850, "South Coast"),
    # Sussex / Kent / Essex / Herts
    "Crawley & Gatwick": (-0.1870, 51.1120, "Sussex"),
    "Brighton": (-0.1410, 50.8270, "Sussex"),
    "Maidstone": (0.5230, 51.2720, "Kent"),
    "Chatham Maritime": (0.5270, 51.4000, "Kent"),
    "Dartford": (0.2190, 51.4460, "Kent"),
    "Chelmsford": (0.4700, 51.7350, "Essex"),
    "Brentwood": (0.3050, 51.6210, "Essex"),
    "Basildon": (0.4890, 51.5720, "Essex"),
    "Braintree": (0.5500, 51.8780, "Essex"),
    "Colchester": (0.9010, 51.8890, "Essex"),
    "Harlow": (0.0930, 51.7720, "Essex"),
    "Watford": (-0.3960, 51.6570, "Hertfordshire"),
    "St Albans": (-0.3360, 51.7520, "Hertfordshire"),
    "Welwyn Garden City": (-0.1930, 51.8010, "Hertfordshire"),
    "Hoddesdon & Cheshunt": (-0.0150, 51.7600, "Hertfordshire"),
    # Ox / Cam / M1
    "Oxford": (-1.2570, 51.7520, "Oxford"),
    "Cambridge": (0.1210, 52.2050, "Cambridge"),
    "Milton Keynes": (-0.7590, 52.0410, "M1 South"),
    # East / South West
    "Ipswich": (1.1550, 52.0570, "East of England"),
    "Norwich": (1.2970, 52.6300, "East of England"),
    "Bath": (-2.3600, 51.3820, "South West"),
    "Swindon": (-1.7850, 51.5610, "South West"),
    "Gloucester": (-2.2450, 51.8650, "South West"),
    "Exeter": (-3.5320, 50.7230, "South West"),
    "Bristol": (-2.5930, 51.4530, "South West"),
    "Bristol (out of town)": (-2.5740, 51.5240, "South West"),
    # Big cities
    "Birmingham": (-1.8990, 52.4800, "Midlands"),
    "Nottingham": (-1.1460, 52.9520, "Midlands"),
    "Leicester": (-1.1320, 52.6350, "Midlands"),
    "Derby": (-1.4750, 52.9210, "Midlands"),
    "Manchester": (-2.2440, 53.4800, "North West"),
    "Liverpool": (-2.9890, 53.4060, "North West"),
    "Leeds": (-1.5480, 53.7970, "Yorkshire"),
    "Sheffield": (-1.4680, 53.3790, "Yorkshire"),
    "Newcastle": (-1.6130, 54.9730, "North East"),
    "Cardiff": (-3.1760, 51.4810, "Wales"),
    "Glasgow": (-4.2580, 55.8610, "Scotland"),
    "Edinburgh": (-3.1970, 55.9520, "Scotland"),
    "Aberdeen": (-2.0980, 57.1480, "Scotland"),
    "Belfast": (-5.9280, 54.5970, "Northern Ireland"),
}

# lowercased source-zone string -> canonical zone
ALIASES = {
    "mayfair & st james's": "Mayfair & St James's",
    "west end core (mayfair, st james's)": "Mayfair & St James's",
    "west end central - mayfair, st james's": "Mayfair & St James's",
    "west end central - mayfair, st james's (prime)": "Mayfair & St James's",
    "west end core - mayfair & st james's": "Mayfair & St James's",
    "west end core": "Mayfair & St James's",
    "west end": "West End (overall)",
    "west end - fitzrovia, marylebone, victoria & westminster, knightsbridge, soho & regent street, paddington": "West End (overall)",
    "soho": "Soho & Leicester Square",
    "west end east - soho": "Soho & Leicester Square",
    "west end east - soho, regent street, leicester square": "Soho & Leicester Square",
    "fitzrovia": "Fitzrovia",
    "west end north east - fitzrovia": "Fitzrovia",
    "north of oxford street": "North of Oxford Street",
    "marylebone": "Marylebone",
    "west end north west - marylebone": "Marylebone",
    "euston & marylebone": "Euston",
    "west end north - euston": "Euston",
    "victoria": "Victoria & Westminster",
    "west end south - victoria, westminster": "Victoria & Westminster",
    "west end south - victoria, westminster, haymarket": "Victoria & Westminster",
    "knightsbridge": "Knightsbridge",
    "knightsbridge/chelsea": "Knightsbridge",
    "west end south west - knightsbridge": "Knightsbridge",
    "chelsea": "Chelsea",
    "kensington": "Kensington & South Kensington",
    "south kensington": "Kensington & South Kensington",
    "paddington": "Paddington",
    "west end west - paddington": "Paddington",
    "covent garden": "Covent Garden & Strand",
    "strand / covent garden": "Covent Garden & Strand",
    "midtown south - covent garden": "Covent Garden & Strand",
    "midtown south - covent garden, strand": "Covent Garden & Strand",
    "bloomsbury": "Bloomsbury",
    "midtown west - bloomsbury": "Bloomsbury",
    "midtown": "Midtown / Holborn",
    "midtown east - holborn": "Midtown / Holborn",
    "midtown - holborn, bloomsbury, king's cross": "Midtown / Holborn",
    "king's cross": "King's Cross",
    "midtown north - king's cross": "King's Cross",
    "euston / king's cross": "King's Cross",
    "city": "City Core",
    "city core": "City Core",
    "city of london prime - bank, leadenhall street": "City Core",
    "city prime - bank, leadenhall street": "City Core",
    "city core - city of london, clerkenwell, farringdon": "City Core",
    "city of london secondary - blackfriars, aldgate": "City Secondary (Blackfriars / Aldgate)",
    "city secondary - blackfriars, aldgate": "City Secondary (Blackfriars / Aldgate)",
    "clerkenwell": "Clerkenwell & Farringdon",
    "clerkenwell/farringdon": "Clerkenwell & Farringdon",
    "city fringe north west - farringdon, smithfield": "Clerkenwell & Farringdon",
    "shoreditch": "Shoreditch",
    "city fringe north - shoreditch, clerkenwell": "Shoreditch",
    "city fringe east - spitalfields": "Spitalfields",
    "aldgate & whitechapel": "Aldgate & Whitechapel",
    "aldgate/whitechapel": "Aldgate & Whitechapel",
    "city fringe east - aldgate east": "Aldgate & Whitechapel",
    "city fringe east - aldgate east, wapping": "Aldgate & Whitechapel",
    "southbank": "Southbank",
    "southbank core": "Southbank",
    "south bank - southwark, london bridge": "Southbank",
    "south bank - waterloo, southwark, london bridge": "Southbank",
    "canary wharf": "Canary Wharf",
    "east london - canary wharf": "Canary Wharf",
    "docklands prime - canary wharf": "Canary Wharf",
    "docklands prime - canary wharf & wood wharf": "Canary Wharf",
    "docklands": "Rest of Docklands / Crossharbour",
    "rest of docklands": "Rest of Docklands / Crossharbour",
    "east london - crossharbour": "Rest of Docklands / Crossharbour",
    "docklands secondary - crossharbour": "Rest of Docklands / Crossharbour",
    "stratford": "Stratford",
    "east london - stratford": "Stratford",
    "eastern fringe - stratford & dalston": "Stratford",
    "royal docks (royals)": "Royal Docks",
    "barking/dagenham/rainham": "Barking & Dagenham",
    "romford": "Romford",
    "white city": "White City",
    "west london - white city, shepherds bush": "White City",
    "hammersmith": "Hammersmith",
    "west london - hammersmith": "Hammersmith",
    "west london (hammersmith/chiswick market)": "Hammersmith",
    "chiswick": "Chiswick",
    "ealing": "Ealing",
    "olympia": "Olympia",
    "vneb (vauxhall nine elms battersea)": "Battersea & Nine Elms",
    "vauxhall/battersea": "Battersea & Nine Elms",
    "battersea, nine elms, vauxhall": "Battersea & Nine Elms",
    "south west london - battersea, nine elms": "Battersea & Nine Elms",
    "richmond": "Richmond",
    "south west london": "South West London (Wimbledon)",
    "croydon": "Croydon",
    "bromley": "Bromley",
    "greenwich": "Greenwich",
    "enfield": "Enfield",
    "reading": "Reading",
    "reading (one station hill, achieved deal)": "Reading",
    "maidenhead": "Maidenhead",
    "maidenhead (town centre)": "Maidenhead",
    "maidenhead (tempo)": "Maidenhead",
    "maidenhead (grade a tone)": "Maidenhead",
    "slough": "Slough",
    "bracknell": "Bracknell",
    "uxbridge": "Uxbridge",
    "heathrow/stockley park": "Heathrow & Stockley Park",
    "staines": "Staines",
    "staines (grade a)": "Staines",
    "staines (average)": "Staines",
    "guildford": "Guildford",
    "woking": "Woking",
    "weybridge": "Weybridge",
    "chertsey": "Chertsey",
    "leatherhead": "Leatherhead",
    "redhill": "Redhill",
    "reigate": "Reigate",
    "camberley": "Camberley",
    "farnborough": "Farnborough",
    "fleet": "Fleet",
    "hook": "Hook",
    "basingstoke": "Basingstoke",
    "southampton": "Southampton",
    "portsmouth (lakeside north harbour)": "Portsmouth",
    "portsmouth (grade a)": "Portsmouth",
    "solent business park (whiteley/fareham)": "Solent Business Park",
    "crawley": "Crawley & Gatwick",
    "crawley/gatwick": "Crawley & Gatwick",
    "brighton": "Brighton",
    "maidstone": "Maidstone",
    "chatham maritime (medway, quoting)": "Chatham Maritime",
    "dartford": "Dartford",
    "chelmsford": "Chelmsford",
    "chelmsford (grade a, top)": "Chelmsford",
    "brentwood": "Brentwood",
    "basildon": "Basildon",
    "braintree": "Braintree",
    "colchester (grade a, top)": "Colchester",
    "harlow": "Harlow",
    "watford": "Watford",
    "st albans": "St Albans",
    "st albans (ct2, achieved deal)": "St Albans",
    "welwyn garden city": "Welwyn Garden City",
    "hoddesdon/cheshunt": "Hoddesdon & Cheshunt",
    "oxford": "Oxford",
    "oxford (town centre)": "Oxford",
    "cambridge": "Cambridge",
    "cambridge (town centre)": "Cambridge",
    "milton keynes": "Milton Keynes",
    "milton keynes (witan gate house, achieved deal)": "Milton Keynes",
    "ipswich": "Ipswich",
    "norwich": "Norwich",
    "bath": "Bath",
    "bath (city centre)": "Bath",
    "swindon (town centre)": "Swindon",
    "swindon (out of town)": "Swindon",
    "gloucester": "Gloucester",
    "gloucester (gloucester business park)": "Gloucester",
    "exeter": "Exeter",
    "bristol": "Bristol",
    "bristol (city centre)": "Bristol",
    "bristol (out of town)": "Bristol (out of town)",
    "bristol (out of town, aztec west)": "Bristol (out of town)",
    "birmingham": "Birmingham",
    "birmingham (city centre)": "Birmingham",
    "nottingham": "Nottingham",
    "leicester": "Leicester",
    "derby": "Derby",
    "manchester": "Manchester",
    "manchester (city centre)": "Manchester",
    "liverpool": "Liverpool",
    "leeds": "Leeds",
    "sheffield": "Sheffield",
    "newcastle": "Newcastle",
    "cardiff": "Cardiff",
    "cardiff (city centre)": "Cardiff",
    "glasgow": "Glasgow",
    "edinburgh": "Edinburgh",
    "aberdeen": "Aberdeen",
    "aberdeen (west end)": "Aberdeen",
    "belfast": "Belfast",
}

# Region-scale aggregates and outliers deliberately not mapped to a zone.
SKIP = {
    "hertfordshire", "surrey powerhouses (guildford/woking area)",
    "south east (regional average headline)", "south east (region, prime)",
    "city (premium/tower space)",
    "west end central - mayfair, st james's (secondary)",
    "reading (1180 winnersh triangle, achieved deal)",
}


def period_score(p):
    """Rough recency for the per-(zone,tier,agent) dedupe. Forecasts rank
    lowest so a real current figure always beats them."""
    s = (p or "").lower()
    if "forecast" in s:
        return 0.0
    m = re.search(r"(20\d\d)", s)
    year = float(m.group(1)) if m else 2000.0
    frac = 0.0
    q = re.search(r"q([1-4])", s)
    if q:
        frac = int(q.group(1)) * 0.25 - 0.1
    elif "h1" in s:
        frac = 0.45
    elif "h2" in s or "year-end" in s or "end" in s:
        frac = 0.9
    else:
        months = ["jan", "feb", "mar", "apr", "may", "jun",
                  "jul", "aug", "sep", "oct", "nov", "dec"]
        for i, mo in enumerate(months):
            if mo in s:
                frac = (i + 1) / 12
                break
    return year + frac


def main():
    raw = json.loads(RAW.read_text())
    figures = raw["figures"] if isinstance(raw, dict) else raw

    unmatched, kept = {}, {}
    for f in figures:
        key = f["zone"].strip().lower().replace("–", "-").replace("—", "-")
        key = re.sub(r"\s+", " ", key.replace("&amp;", "&"))
        if key in SKIP:
            continue
        zone = ALIASES.get(key)
        if not zone:
            unmatched[f["zone"]] = unmatched.get(f["zone"], 0) + 1
            continue
        tier = f["tier"]
        if tier not in ("prime", "mid", "low"):
            continue
        dk = (zone, tier, f["agent"])
        if dk not in kept or period_score(f.get("period")) > period_score(kept[dk].get("period")):
            kept[dk] = f

    zones = {}
    for (zone, tier, agent), f in kept.items():
        z = zones.setdefault(zone, {"prime": [], "mid": [], "low": []})
        z[tier].append({"a": agent, "v": round(float(f["rent_psf"]), 2),
                        "p": f.get("period") or "", "src": f.get("publication") or ""})

    out = []
    for zone, tiers in sorted(zones.items()):
        lng, lat, region = ZONES[zone]
        rec = {"zone": zone, "lng": lng, "lat": lat, "region": region}
        for tier in ("prime", "mid", "low"):
            vals = sorted(tiers[tier], key=lambda v: -v["v"])
            if vals:
                rec[tier] = {"avg": round(statistics.mean(v["v"] for v in vals), 2),
                             "vals": vals}
        if not any(t in rec for t in ("prime", "mid", "low")):
            continue
        out.append(rec)

    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    n_figs = sum(len(rec.get(t, {}).get("vals", [])) for rec in out for t in ("prime", "mid", "low"))
    print(f"{len(out)} zones, {n_figs} figures -> {OUT.name}")
    if unmatched:
        print("UNMATCHED zone names (add to ALIASES or SKIP):")
        for z, n in sorted(unmatched.items()):
            print(f"  {n}x {z}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
