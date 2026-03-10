import json
import os
import requests
import re
import zoneinfo
from datetime import datetime, timezone, timedelta

# --- CONFIGURATION ---
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

# STANDARD TEAM CODES
TEAM_MAP = {
    'GS': 'GSW', 'GOLDEN STATE': 'GSW', 'GSW': 'GSW',
    'NO': 'NOP', 'NEW ORLEANS': 'NOP', 'NOP': 'NOP', 'NOH': 'NOP', 'PELICANS': 'NOP', 'NOR': 'NOP',
    'NY': 'NYK', 'NEW YORK': 'NYK', 'NYK': 'NYK', 'KNICKS': 'NYK',
    'SA': 'SAS', 'SAN ANTONIO': 'SAS', 'SAS': 'SAS', 'SPURS': 'SAS',
    'PHO': 'PHX', 'PHOENIX': 'PHX', 'PHX': 'PHX',
    'UT': 'UTA', 'UTAH': 'UTA', 'UTA': 'UTA', 'JAZZ': 'UTA',
    'WSH': 'WAS', 'WASHINGTON': 'WAS', 'WAS': 'WAS',
    'BKO': 'BKN', 'BROOKLYN': 'BKN', 'BKN': 'BKN',
    'CHO': 'CHA', 'CHA': 'CHA', 'CHARLOTTE': 'CHA'
}

# NICKNAME MAP
# NICKNAMES MAP
NICKNAMES = {
    'cam': 'cameron', 'nic': 'nicolas', 'patti': 'patrick', 'pat': 'patrick',
    'mo': 'moritz', 'moe': 'moritz', 'zach': 'zachary', 'tim': 'timothy',
    'kj': 'kenyon', 'x': 'xavier', 'herb': 'herbert', 'bub': 'carrinton',
    'greg': 'gregory', 'nick': 'nicholas', 'mitch': 'mitchell', 'kelly': 'kelly',
    'pj': 'pj', 'trey': 'trey', 'cj': 'cj', 'c.j.': 'cj', 'shai': 'shai',
    'alexandre': 'alex'  # Added for Alexandre Sarr
}

def normalize_team(team_name):
    if not team_name: return ""
    clean_name = re.sub(r'[\r\n\t\d\xa0]', '', str(team_name)).strip().upper()
    return TEAM_MAP.get(clean_name, clean_name)

def clean_player_name(name):
    if not name or name == '-': return ""
    name = str(name).lower().strip()
    name = name.replace('.', '').replace("'", "")
    for suffix in [' jr', ' sr', ' ii', ' iii', ' iv']:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    
    parts = name.split()
    if parts and parts[0] in NICKNAMES:
        parts[0] = NICKNAMES[parts[0]]
    
    return " ".join(parts)

def parse_time_to_minutes(time_str):
    try:
        t = datetime.strptime(time_str.strip().upper(), "%I:%M %p")
        return t.hour * 60 + t.minute
    except:
        return 9999

# --- FETCH PRECISE DATES & TIMES FROM ESPN ---
def get_espn_schedule_data():
    print("--- Fetching true game dates and times from ESPN ---")
    team_schedule = {}
    try:
        ny_tz = zoneinfo.ZoneInfo("America/New_York")
        now_est = datetime.now(ny_tz)
        
        for i in range(3):
            target_date = now_est + timedelta(days=i)
            date_str = target_date.strftime('%Y%m%d')
            
            url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={date_str}"
            res = requests.get(url, timeout=10)
            data = res.json()
            
            for ev in data.get('events', []):
                utc_date_str = ev['date'].replace('Z', '+00:00')
                dt_utc = datetime.fromisoformat(utc_date_str)
                dt_est = dt_utc.astimezone(ny_tz)
                
                local_date_format = dt_est.strftime('%Y-%m-%d')
                local_time_format = dt_est.strftime('%I:%M %p').lstrip('0')
                
                for comp in ev['competitions'][0]['competitors']:
                    team_abbr = normalize_team(comp['team']['abbreviation'])
                    if team_abbr not in team_schedule:
                        team_schedule[team_abbr] = {
                            "date": local_date_format,
                            "time": local_time_format
                        }
    except Exception as e:
        print(f"ESPN Date/Time Fetch Error: {e}")
    return team_schedule

# --- SCRAPE BASKETBALL MONSTER ---
def scrape_starters():
    print(f"--- SCRAPING {BBM_URL} ---")
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=15)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, 'html.parser')
        rows = soup.find_all('tr')
    except Exception as e:
        print(f"CRITICAL ERROR SCRAPING BBM: {e}")
        return {}

    starters_map = {} 
    
    for row in rows:
        cells = row.find_all(['td', 'th'])
        cols_text = [c.get_text(strip=True) for c in cells]
        
        if not cols_text: continue
        
        is_header = False
        raw_away, raw_home = "", ""
        
        if len(cols_text) >= 3:
            if "@" in cols_text[2]: 
                raw_away, raw_home = cols_text[1], cols_text[2]
                is_header = True
            elif "@" in cols_text[1]: 
                raw_away, raw_home = cols_text[0], cols_text[1]
                is_header = True
        
        if is_header:
            team_away = normalize_team(raw_away.replace('@', ''))
            team_home = normalize_team(raw_home.replace('@', ''))
            if team_away not in starters_map: starters_map[team_away] = []
            if team_home not in starters_map: starters_map[team_home] = []
            continue

        if len(cols_text) >= 3 and cols_text[0] in ['PG', 'SG', 'SF', 'PF', 'C']:
            if not starters_map: continue
            
            active_teams = list(starters_map.keys())[-2:]
            tm_away = active_teams[0]
            tm_home = active_teams[1]
            
            def extract_player_info(cell):
                link = cell.find('a', href=True)
                if link and 'playerinfo.aspx' in link['href']:
                    name = link.get_text(strip=True)
                    classes = cell.get('class', [])
                    is_verified = 'verified' in classes
                    return {'name': name, 'verified': is_verified}
                return None

            if len(starters_map[tm_away]) < 5:
                p_info = extract_player_info(cells[1])
                if p_info: starters_map[tm_away].append(p_info)

            if len(starters_map[tm_home]) < 5:
                p_info = extract_player_info(cells[2])
                if p_info: starters_map[tm_home].append(p_info)

    print(f"Scraped {len(starters_map)} teams from BBM.")
    return starters_map

# --- DYNAMIC SLATE CRAWLER FOR DFF ---
def scrape_dff_projections(target_date_str):
    print(f"--- SCRAPING DAILY FANTASY FUEL FOR {target_date_str} ---")
    dff_data = {}
    platforms = ['fanduel', 'draftkings']
    
    for platform in platforms:
        base_url = f"https://www.dailyfantasyfuel.com/nba/projections/{platform}/{target_date_str}"
        
        try:
            response = requests.get(base_url, headers=HEADERS, timeout=15)
            if response.status_code != 200:
                print(f"{platform.upper()} returned status {response.status_code}. Skipping.")
                continue

            html_text = response.text
            slate_ids = set()
            
            # 1. Catch slates in standard URL links
            slate_ids.update(re.findall(r'slate=([a-zA-Z0-9_-]{4,15})', html_text))
            
            # 2. Catch slates in pre-rendered Modal tags
            slate_ids.update(re.findall(r'data-slate=["\']([a-zA-Z0-9_-]{4,15})["\']', html_text))
            
            # 3. ULTIMATE FIX: Rip the slate IDs directly out of the hidden JSON arrays
            slates_arrays = re.findall(r'"slates"\s*:\s*\[(.*?)\]', html_text, re.IGNORECASE)
            for arr in slates_arrays:
                ids = re.findall(r'"id"\s*:\s*"([a-zA-Z0-9_-]{4,15})"', arr)
                slate_ids.update(ids)
                
            # 4. Fallback for alternate JSON naming conventions
            slate_ids.update(re.findall(r'"slateId"\s*:\s*"([a-zA-Z0-9_-]{4,15})"', html_text))
            
            print(f"Found {len(slate_ids)} unique slates for {platform.upper()}: {slate_ids}")
            
            urls_to_scrape = [base_url]
            for sid in slate_ids:
                urls_to_scrape.append(f"{base_url}?slate={sid}")
                
            scraped_urls = set()
            from bs4 import BeautifulSoup
            
            for url in urls_to_scrape:
                if url in scraped_urls: continue
                scraped_urls.add(url)
                
                res = requests.get(url, headers=HEADERS, timeout=15)
                if res.status_code != 200: continue
                
                soup = BeautifulSoup(res.text, 'html.parser')
                
                for row in soup.find_all('tr', class_='projections-listing'):
                    team_raw = row.get('data-team')
                    if not team_raw: continue
                    
                    team = normalize_team(team_raw)
                    raw_name = row.get('data-name', '')
                    clean_name = clean_player_name(raw_name)
                    
                    try:
                        raw_sal = row.get('data-salary', '0')
                        raw_proj = row.get('data-ppg_proj', '0')
                        raw_val = row.get('data-value_proj', '0')
                        
                        sal = float(raw_sal if raw_sal else '0')
                        proj = float(raw_proj if raw_proj else '0')
                        val = float(raw_val if raw_val else '0')
                    except:
                        sal, proj, val = 0, 0, 0
                        
                    pos = row.get('data-pos', 'Flex')
                    injury = row.get('data-inj', '')
                    
                    p_key = f"{team}_{clean_name}"
                    
                    if p_key not in dff_data:
                        dff_data[p_key] = {
                            "name": raw_name, "injury": injury,
                            "pos": "Flex", "salary": 0, "proj": 0.0, "value": 0.0,
                            "dk_pos": "Flex", "dk_salary": 0, "dk_proj": 0.0, "dk_value": 0.0
                        }
                    
                    # Store data if valid salary exists
                    if platform == 'fanduel' and sal > 0:
                        dff_data[p_key]["pos"] = pos
                        dff_data[p_key]["salary"] = int(sal)
                        dff_data[p_key]["proj"] = round(proj, 1)
                        dff_data[p_key]["value"] = round(val, 2)
                        if injury: dff_data[p_key]["injury"] = injury
                    elif platform == 'draftkings' and sal > 0:
                        dff_data[p_key]["dk_pos"] = pos
                        dff_data[p_key]["dk_salary"] = int(sal)
                        dff_data[p_key]["dk_proj"] = round(proj, 1)
                        dff_data[p_key]["dk_value"] = round(val, 2)
                        if injury: dff_data[p_key]["injury"] = injury
                        
            print(f"Successfully scraped {len(scraped_urls)} slates for {platform.upper()}.")
            
        except Exception as e:
            print(f"Error scraping DFF ({platform}): {e}")
            
    return dff_data

# --- MAIN LOGIC ---
def build_json():
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    et_now = datetime.now(ny_tz)
    current_date_str = et_now.strftime("%Y-%m-%d")
    yesterday_str = (et_now - timedelta(days=1)).strftime("%Y-%m-%d")
    valid_dates = [current_date_str, yesterday_str]
    
    old_memory = {}
    if os.path.exists('nba_data.json'):
        try:
            with open('nba_data.json', 'r') as f:
                old_data = json.load(f)
                for g in old_data.get('games', []):
                    clean_id = str(g['id']).replace('\r', '').replace('\n', '').replace(' ', '')
                    g_date = g.get("date_added", current_date_str)
                    if g_date in valid_dates:
                        g['date_added'] = g_date 
                        old_memory[clean_id] = g
        except: pass

    team_schedule = get_espn_schedule_data()
    scraped_rosters = scrape_starters()
    
    # -------------------------------------------------------------
    # THE FIX: SCRAPE MULTIPLE DATES BASED ON THE ESPN SCHEDULE
    # -------------------------------------------------------------
    unique_dates = set()
    for team_data in team_schedule.values():
        if "date" in team_data:
            unique_dates.add(team_data["date"])
            
    # Fallback to ensure today is always scraped
    unique_dates.add(current_date_str)
    
    # Master dictionary for all projected players
    dff_projections = {}
    
    for d_str in unique_dates:
        slate_data = scrape_dff_projections(d_str)
        # Merge this date's projections into the master dictionary
        for player_key, stats in slate_data.items():
            # If the player is already in master dict, only overwrite if we found a >$0 salary
            if player_key not in dff_projections or (dff_projections[player_key]['salary'] == 0 and stats['salary'] > 0):
                dff_projections[player_key] = stats

    teams_list = list(scraped_rosters.keys())
    new_games_dict = {}
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")
    
    print("\n--- MATCHING PLAYERS ---")

    for i in range(0, len(teams_list), 2):
        if i+1 >= len(teams_list): break
        
        team_a = teams_list[i]
        team_b = teams_list[i+1]
        
        schedule_info = team_schedule.get(team_a) or team_schedule.get(team_b, {})
        game_date = schedule_info.get("date", current_date_str)
        game_time = schedule_info.get("time", "TBD")
        
        game_id = f"{team_a}-{team_b}-{game_date}"
        
        old_game = old_memory.get(game_id, {})
        old_meta = old_game.get("meta", {})
        
        spread_str = str(old_meta.get("spread", "TBD"))
        total_str = str(old_meta.get("total", "TBD"))
        
        if spread_str in ["nan", "+nan", "None"]: spread_str = "TBD"
        if total_str in ["nan", "+nan", "None"]: total_str = "TBD"

        game_obj = {
            "id": game_id,
            "date": game_date, 
            "date_added": current_date_str, 
            "teams": [team_a, team_b],
            "meta": {
                "spread": spread_str,
                "total": total_str,
                "time": game_time 
            },
            "rosters": {}
        }
        
        for team in [team_a, team_b]:
            starters_data = scraped_rosters.get(team, [])
            player_list = []
            
            for p_obj in starters_data:
                raw_name = p_obj['name']
                is_verified = p_obj['verified']
                clean = clean_player_name(raw_name)
                
                # Setup default fallback with DK fields
                p_data = {
                    "pos": "Flex", "name": raw_name,
                    "salary": 0, "proj": 0, "value": 0,
                    "dk_pos": "Flex", "dk_salary": 0, "dk_proj": 0, "dk_value": 0,
                    "injury": "", "verified": is_verified 
                }
                
                # Check new DFF Scrape First
                p_key = f"{team}_{clean}"
                if p_key in dff_projections:
                    dff_p = dff_projections[p_key]
                    p_data.update({
                        "pos": dff_p.get('pos', 'Flex'),
                        "salary": dff_p.get('salary', 0),
                        "proj": dff_p.get('proj', 0),
                        "value": dff_p.get('value', 0),
                        "dk_pos": dff_p.get('dk_pos', 'Flex'),
                        "dk_salary": dff_p.get('dk_salary', 0),
                        "dk_proj": dff_p.get('dk_proj', 0),
                        "dk_value": dff_p.get('dk_value', 0),
                        "injury": dff_p.get('injury', '')
                    })
                else:
                    # Smart Fallback
                    parts = clean.split()
                    if len(parts) >= 2:
                        last_name = parts[-1]
                        first_initial = parts[0][0]
                        for d_key, d_val in dff_projections.items():
                            if d_key.startswith(f"{team}_") and last_name in d_key and d_key.split('_')[1].startswith(first_initial):
                                p_data.update({
                                    "pos": d_val.get('pos', 'Flex'),
                                    "salary": d_val.get('salary', 0),
                                    "proj": d_val.get('proj', 0),
                                    "value": d_val.get('value', 0),
                                    "dk_pos": d_val.get('dk_pos', 'Flex'),
                                    "dk_salary": d_val.get('dk_salary', 0),
                                    "dk_proj": d_val.get('dk_proj', 0),
                                    "dk_value": d_val.get('dk_value', 0),
                                    "injury": d_val.get('injury', '')
                                })
                                break

                    # Last Resort Fallback (from old memory)
                    if p_data["salary"] == 0 and old_game:
                        old_roster = old_game.get('rosters', {}).get(team, {}).get('players', [])
                        for old_p in old_roster:
                            if clean_player_name(old_p['name']) == clean:
                                p_data.update({
                                    "pos": old_p.get("pos", "Flex"),
                                    "salary": old_p.get("salary", 0),
                                    "proj": old_p.get("proj", 0),
                                    "value": old_p.get("value", 0),
                                    "dk_pos": old_p.get("dk_pos", "Flex"),
                                    "dk_salary": old_p.get("dk_salary", 0),
                                    "dk_proj": old_p.get("dk_proj", 0),
                                    "dk_value": old_p.get("dk_value", 0)
                                })
                                break
                
                player_list.append(p_data)
            
            if not player_list:
                 player_list.append({"pos": "-", "name": "Waiting for Lineup", "salary": 0, "proj": 0, "value": 0, "dk_pos": "-", "dk_salary": 0, "dk_proj": 0, "dk_value": 0, "injury": "", "verified": False})

            game_obj['rosters'][team] = {
                "logo": f"https://a.espncdn.com/i/teamlogos/nba/500/{team.lower()}.png",
                "players": player_list
            }
            
        new_games_dict[game_id] = game_obj

    for g_id, g_obj in new_games_dict.items():
        old_memory[g_id] = g_obj
        
    games_output = list(old_memory.values())

    for g in games_output:
        g['sort_index'] = parse_time_to_minutes(g['meta'].get('time', '7:00 PM'))
        
    games_output.sort(key=lambda x: x['sort_index'])
    
    for g in games_output: 
        if 'sort_index' in g:
            del g['sort_index']
    
    final_json = {
        "last_updated": formatted_time,
        "games": games_output
    }
    
    with open('nba_data.json', 'w') as f:
        json.dump(final_json, f, indent=2)
    
    print(f"SUCCESS. Generated {len(games_output)} games.")

if __name__ == "__main__":
    build_json()



