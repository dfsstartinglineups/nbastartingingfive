import json
import os
import requests
import re
import zoneinfo
from datetime import datetime, timezone, timedelta

# --- SELENIUM IMPORTS ---
from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from webdriver_manager.chrome import ChromeDriverManager
import time
from bs4 import BeautifulSoup

# ==========================================================
# --- FOLDER SETUP ---
# ==========================================================
# Since this script runs in /scripts, we point up one level to the root
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
LEGACY_FILE = os.path.join(SCRIPT_DIR, '..', 'nba_data.json')

# Ensure the data directory exists
os.makedirs(DATA_DIR, exist_ok=True)

# ==========================================================
# --- CONFIGURATION ---
# ==========================================================
BBM_URL = "https://basketballmonster.com/nbalineups.aspx"
BBM_NEWS_URL = "https://basketballmonster.com/playernews.aspx"

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

# NICKNAMES MAP
NICKNAMES = {
    'cam': 'cameron', 'nic': 'nicolas', 'patti': 'patrick', 'pat': 'patrick',
    'mo': 'moritz', 'moe': 'moritz', 'zach': 'zachary', 'tim': 'timothy',
    'kj': 'kenyon', 'x': 'xavier', 'herb': 'herbert', 'bub': 'carrinton',
    'greg': 'gregory', 'nick': 'nicholas', 'mitch': 'mitchell', 'kelly': 'kelly',
    'pj': 'pj', 'trey': 'trey', 'cj': 'cj', 'c.j.': 'cj', 'shai': 'shai',
    'alexandre': 'alex', 'elijah': 'ej',
    'gg': 'gregory'
}

def normalize_team(team_name):
    if not team_name: return ""
    clean_name = re.sub(r'[\r\n\t\d\xa0]', '', str(team_name)).strip().upper()
    return TEAM_MAP.get(clean_name, clean_name)

def clean_player_name(name):
    if not name or name == '-': return ""
    name = str(name).lower().strip()
    name = name.replace('.', '').replace("'", "")
    
    name = re.sub(r'^([a-z])\s([a-z])\s', r'\1\2 ', name)
    
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

# --- NEW: NEWS MEMORY MERGER ---
def merge_news_lists(old_news, new_news):
    """
    Merges news arrays. If a duplicate (Same Player, Badge, and Description) 
    is found, it keeps only the freshest one.
    """
    # Using a dictionary where the key is the "Fingerprint"
    # This automatically handles de-duplication
    merged_dict = {}
    
    # Process old news first, then new news. 
    # Because we process new_news LAST, it will overwrite any 
    # matching old items with the fresher 'time_elapsed'.
    for n in (old_news + new_news):
        name = str(n.get('player_name', '')).strip()
        # Normalize badge to uppercase to match your JS switch cases (e.g., 2NDHALF)
        badge = str(n.get('status_badge', '')).strip().upper()
        # Normalize description to catch minor spacing differences
        desc = str(n.get('description', '')).strip()
        
        # THE FINGERPRINT KEY
        # If these three match, it's the same news event.
        key = f"{name}_{badge}_{desc}"
        
        if key:
            merged_dict[key] = n
            
    # Convert back to a list
    merged_list = list(merged_dict.values())
    
    # Sort the final list so the freshest items are at the top
    def get_time_weight(news_item):
        time_str = str(news_item.get('time_elapsed', '999d')).lower()
        try:
            # Extract numbers/decimals (handles "1.1h", "20m", etc.)
            val_str = ''.join([c for c in time_str if c.isdigit() or c == '.'])
            if not val_str: return 999999
            val = float(val_str)
            if 'm' in time_str: return val
            if 'h' in time_str: return val * 60
            if 'd' in time_str: return val * 1440
            return val
        except:
            return 999999
        
    merged_list.sort(key=get_time_weight)
    return merged_list

# ==========================================================
# --- RAW ESPN SCOREBOARD FETCH (FOR THE NEW BUNDLED JSON) ---
# ==========================================================
def fetch_espn_scoreboard(espn_date_str):
    url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={espn_date_str}"
    try:
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception as e:
        print(f"ESPN Scoreboard API Error for {espn_date_str}: {e}")
    return {}

# ==========================================================
# --- FETCH PRECISE DATES & TIMES FROM ESPN ---
# ==========================================================
def get_espn_schedule_data():
    print("--- Fetching true game dates and times from ESPN ---")
    team_schedule = {}
    try:
        ny_tz = zoneinfo.ZoneInfo("America/New_York")
        now_est = datetime.now(ny_tz)
        
        for i in range(-1, 2):
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
                        team_schedule[team_abbr] = []
                        
                    team_schedule[team_abbr].append({
                        "date": local_date_format,
                        "time": local_time_format
                    })
    except Exception as e:
        print(f"ESPN Date/Time Fetch Error: {e}")
    return team_schedule

# ==========================================================
# --- SCRAPE BASKETBALL MONSTER PLAYER NEWS ---
# ==========================================================
def scrape_bbm_player_news():
    print(f"--- SCRAPING {BBM_NEWS_URL} ---")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
    }
    
    try:
        response = requests.get(BBM_NEWS_URL, headers=headers, timeout=15)
        if response.status_code != 200:
            print(f"⚠️ Failed to fetch BBM News. Status Code: {response.status_code}")
            return []
        html_content = response.text
    except Exception as e:
        print(f"⚠️ Network error fetching BBM News: {e}")
        return []

    soup = BeautifulSoup(html_content, 'html.parser')
    news_items = soup.find_all('div', class_='q-su-item')
    
    if not news_items:
        print("❌ Could not find any news items on BBM.")
        return []
    
    extracted_news = []
    
    for item in news_items:
        news_data = {}
        
        # 1. Player Name
        title_span = item.find('span', class_='q-title')
        if title_span and title_span.a:
            news_data['player_name'] = title_span.a.text.strip()
            
        # 2. Team & Position
        player_info_spans = item.find_all('span', class_='q-player-info')
        if len(player_info_spans) >= 2:
            news_data['team'] = normalize_team(player_info_spans[0].text.strip())
            news_data['position'] = player_info_spans[1].text.strip()
            
        # 3. STATUS BADGE (The Fix for 2ndHalf/LR)
        status_square = item.find('span', class_='status-square')
        badge_val = ""
        if status_square:
            # .get_text(strip=True) ignores the <i> and <small> tags entirely
            badge_val = status_square.get_text(strip=True).upper()
            news_data['status_badge'] = badge_val
            
        # 4. DESCRIPTION (The Fix for Duplication)
        status_div = item.find('div', class_='status-update-player-status')
        if status_div:
            # We get the raw text and remove the Badge and the "Level" tags
            raw_text = status_div.get_text(separator=" ", strip=True)
            clean_desc = raw_text.replace(badge_val, "").strip()
            # Remove "high level", "medium level", etc.
            clean_desc = re.sub(r'(high|medium|low|monster)\s+level', '', clean_desc, flags=re.IGNORECASE).strip()
            # Strip leading/trailing hyphens or dots often left behind
            clean_desc = clean_desc.lstrip('- ').strip()
            news_data['description'] = clean_desc
                 
        # 5. Time and Next Game
        time_div = item.find('div', class_='q-date')
        news_data['time_elapsed'] = time_div.text.strip() if time_div else "0m"
            
        small_divs = item.find_all('div', class_='ml-1 small')
        game_divs = [div for div in small_divs if 'text-muted' not in div.get('class', [])]
        if game_divs:
            news_data['next_game'] = game_divs[-1].text.strip()
            
        extracted_news.append(news_data)
        
    print(f"Scraped {len(extracted_news)} player news items.")
    return extracted_news

# ==========================================================
# --- SCRAPE BASKETBALL MONSTER STARTERS ---
# ==========================================================
def scrape_starters():
    print(f"--- SCRAPING {BBM_URL} ---")
    try:
        response = requests.get(BBM_URL, headers=HEADERS, timeout=15)
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

# GLOBAL SLATE DIRECTORY
GLOBAL_SLATES = {'fanduel': {}, 'draftkings': {}}

# ==========================================================
# --- DYNAMIC SLATE CRAWLER FOR DFF (HYBRID BOT) ---
# ==========================================================
def scrape_dff_projections(target_date_str):
    print(f"\n--- BROWSER BOT STARTING FOR: {target_date_str} ---")
    dff_data = {}
    platforms = ['fanduel', 'draftkings']
    
    chrome_options = Options()
    chrome_options.add_argument("--headless") 
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
    
    try:
        driver = webdriver.Chrome(service=ChromeService(ChromeDriverManager().install()), options=chrome_options)
    except Exception as e:
        print(f"Failed to launch browser bot: {e}")
        return dff_data

    for platform in platforms:
        base_url = f"https://www.dailyfantasyfuel.com/nba/projections/{platform}/{target_date_str}"
        slate_ids = set()
        
        try:
            print(f"Loading {platform.upper()} Base URL: {base_url}")
            driver.get(base_url)
            time.sleep(2) 
            
            try:
                toggles = driver.find_elements(By.XPATH, "//*[contains(translate(text(), 'SLATE', 'slate'), 'slate') or contains(translate(text(), 'MAIN', 'main'), 'main') or contains(@class, 'slate')]")
                for t in toggles:
                    try:
                        if not t.get_attribute("href"):
                            driver.execute_script("arguments[0].click();", t)
                    except: pass
                time.sleep(1) 
            except: pass

            # --- BULLETPROOF SLATE EXTRACTION ---
            soup = BeautifulSoup(driver.page_source, 'html.parser')
            
            def add_slate_name(sid, name):
                if not sid or not re.match(r'^[a-zA-Z0-9]{5}$', str(sid)): return
                slate_ids.add(sid)
                name = str(name).strip()
                if name and len(name) > 2:
                    bad_names = ["projections", "matchups", "odds", "starting lineups", "players", "lineups", "optimizer"]
                    if name.lower() not in bad_names:
                        if sid not in GLOBAL_SLATES[platform] or GLOBAL_SLATES[platform][sid].startswith("Slate "):
                            clean_name = re.sub(r'^(FD|DK)\s+', '', name, flags=re.IGNORECASE).strip()
                            if clean_name:
                                GLOBAL_SLATES[platform][sid] = clean_name

            # 1. Look in Option tags
            active_sid = None
            for opt in soup.find_all('option'):
                val = opt.get('value', '')
                if opt.has_attr('selected'): active_sid = val
                add_slate_name(val, opt.get_text(separator=" ", strip=True))
                
            # 2. Look in React Divs/Spans with data-slate
            for el in soup.find_all(attrs={"data-slate": True}):
                add_slate_name(el.get("data-slate", ""), el.get_text(separator=" ", strip=True))
                
            # 3. Look in Links with slate=
            for a in soup.find_all('a', href=True):
                match = re.search(r'slate=([a-zA-Z0-9]{5})', a['href'])
                if match:
                    add_slate_name(match.group(1), a.get_text(separator=" ", strip=True))

            # 4. Fallback Regex
            html_text = driver.page_source
            matches = re.findall(r'slate=["\']?([a-zA-Z0-9]{5})', html_text)
            for m in matches:
                slate_ids.add(m)
                if m not in GLOBAL_SLATES[platform]:
                    GLOBAL_SLATES[platform][m] = f"Slate {m}"
            
            print(f"Browser found {len(slate_ids)} valid slates: {slate_ids}")
            
            def parse_row(row, plt, sid):
                team_raw = row.get('data-team')
                if not team_raw: return
                
                team = normalize_team(team_raw)
                raw_name = row.get('data-name', '')
                clean_name = clean_player_name(raw_name)
                
                try:
                    sal = float(row.get('data-salary', '0') or '0')
                    proj = float(row.get('data-ppg_proj', '0') or '0')
                    val = float(row.get('data-value_proj', '0') or '0')
                except:
                    sal, proj, val = 0, 0, 0
                    
                # --- NEW: COMBINE PRIMARY AND ALT POSITIONS ---
                pos = row.get('data-pos', 'Flex').strip()
                pos_alt = row.get('data-pos_alt', '').strip()
                combined_pos = f"{pos}/{pos_alt}" if pos_alt else pos
                
                injury = row.get('data-inj', '')
                
                p_key = f"{team}_{clean_name}"
                
                if p_key not in dff_data:
                    dff_data[p_key] = {
                        "name": raw_name, "injury": injury, "pos": "Flex", "salary": 0, "proj": 0.0, "value": 0.0,
                        "dk_pos": "Flex", "dk_salary": 0, "dk_proj": 0.0, "dk_value": 0.0,
                        "fd_slates": {}, "dk_slates": {},
                        "fd_positions": "", "dk_positions": "" 
                    }
                
                if plt == 'fanduel' and sal > 0:
                    dff_data[p_key]["pos"] = combined_pos # Save full string to backwards compatible field
                    dff_data[p_key]["fd_positions"] = combined_pos # Save to new explicit field
                    if injury: dff_data[p_key]["injury"] = injury
                    if sid:
                        dff_data[p_key]["fd_slates"][sid] = {
                            "salary": int(sal), "proj": round(proj, 1), "value": round(val, 2)
                        }
                        
                elif plt == 'draftkings' and sal > 0:
                    dff_data[p_key]["dk_pos"] = combined_pos # Save full string to backwards compatible field
                    dff_data[p_key]["dk_positions"] = combined_pos # Save to new explicit field
                    if injury: dff_data[p_key]["injury"] = injury
                    if sid:
                        dff_data[p_key]["dk_slates"][sid] = {
                            "salary": int(sal), "proj": round(proj, 1), "value": round(val, 2)
                        }

            print(f"Scraping initial rendered slate: {base_url}")
            if active_sid:
                for row in soup.find_all('tr', class_='projections-listing'):
                    parse_row(row, platform, active_sid)
            
            for sid in slate_ids:
                if sid == active_sid: continue
                print(f"Rapid JSON Scrape for Slate: {sid}")
                try:
                    api_headers = HEADERS.copy()
                    api_headers['X-Requested-With'] = 'XMLHttpRequest'
                    res = requests.get(f"{base_url}?slate={sid}", headers=api_headers, timeout=5)
                    
                    if res.status_code == 200:
                        sub_soup = BeautifulSoup(res.text, 'html.parser')
                        for row in sub_soup.find_all('tr', class_='projections-listing'):
                            parse_row(row, platform, sid)
                except: pass
                
            print(f"Successfully compiled all slates for {platform.upper()}.")
            
        except Exception as e:
            print(f"Error scraping DFF ({platform}): {e}")
            
    print("Applying priority waterfall logic for default DFS stats...")
    
    def get_slate_priority(slate_name):
        name_lower = slate_name.lower()
        if "all day" in name_lower: return 1
        elif "main" in name_lower: return 2
        elif "@" in name_lower or "showdown" in name_lower or "single game" in name_lower or "captain" in name_lower: return 4
        else: return 3
        
    for p_key, p_data in dff_data.items():
        # Fanduel
        best_fd_sid = None
        best_fd_pri = 99
        for sid, stats in p_data["fd_slates"].items():
            s_name = GLOBAL_SLATES['fanduel'].get(sid, "")
            pri = get_slate_priority(s_name)
            if pri < best_fd_pri:
                best_fd_pri = pri
                best_fd_sid = sid
            elif pri == best_fd_pri:
                if stats["proj"] > p_data["fd_slates"][best_fd_sid]["proj"]:
                    best_fd_sid = sid
        if best_fd_sid:
            p_data["salary"] = p_data["fd_slates"][best_fd_sid]["salary"]
            p_data["proj"] = p_data["fd_slates"][best_fd_sid]["proj"]
            p_data["value"] = p_data["fd_slates"][best_fd_sid]["value"]
            
        # DraftKings
        best_dk_sid = None
        best_dk_pri = 99
        for sid, stats in p_data["dk_slates"].items():
            s_name = GLOBAL_SLATES['draftkings'].get(sid, "")
            pri = get_slate_priority(s_name)
            if pri < best_dk_pri:
                best_dk_pri = pri
                best_dk_sid = sid
            elif pri == best_dk_pri:
                if stats["proj"] > p_data["dk_slates"][best_dk_sid]["proj"]:
                    best_dk_sid = sid
        if best_dk_sid:
            p_data["dk_salary"] = p_data["dk_slates"][best_dk_sid]["salary"]
            p_data["dk_proj"] = p_data["dk_slates"][best_dk_sid]["proj"]
            p_data["dk_value"] = p_data["dk_slates"][best_dk_sid]["value"]

    driver.quit() 
    return dff_data

# ==========================================================
# --- MAIN LOGIC ---
# ==========================================================
def build_json():
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    et_now = datetime.now(ny_tz)
    
    current_date_str = et_now.strftime("%Y-%m-%d")
    tomorrow_str = (et_now + timedelta(days=1)).strftime("%Y-%m-%d")
    yesterday_str = (et_now - timedelta(days=1)).strftime("%Y-%m-%d")
    
    current_espn_date = et_now.strftime("%Y%m%d")
    tomorrow_espn_date = (et_now + timedelta(days=1)).strftime("%Y%m%d")
    
    # --- GET DAY OF THE WEEK FOR NEWS FILTERING ---
    today_weekday = et_now.strftime("%A")
    tomorrow_weekday = (et_now + timedelta(days=1)).strftime("%A")
    
    valid_dates = [yesterday_str, current_date_str, tomorrow_str]
    
    # ----------------------------------------------------
    # LOAD EXISTING MEMORY BEFORE DOING ANYTHING NEW
    # ----------------------------------------------------
    old_memory = {}
    old_legacy_news = []
    if os.path.exists(LEGACY_FILE):
        try:
            with open(LEGACY_FILE, 'r') as f:
                old_data = json.load(f)
                old_legacy_news = old_data.get('player_news', [])
                for g in old_data.get('games', []):
                    clean_id = str(g['id']).replace('\r', '').replace('\n', '').replace(' ', '')
                    g_date = g.get("date", current_date_str)
                    if g_date in valid_dates:
                        old_memory[clean_id] = g
        except Exception as e:
            print(f"Failed to load memory: {e}")

    # Load Existing Daily Files (to preserve old news items from earlier in the day)
    today_file_path = os.path.join(DATA_DIR, f"{current_date_str}.json")
    tomorrow_file_path = os.path.join(DATA_DIR, f"{tomorrow_str}.json")

    old_today_news = []
    if os.path.exists(today_file_path):
        try:
            with open(today_file_path, 'r') as f:
                old_today_news = json.load(f).get('player_news', [])
        except: pass

    old_tomorrow_news = []
    if os.path.exists(tomorrow_file_path):
        try:
            with open(tomorrow_file_path, 'r') as f:
                old_tomorrow_news = json.load(f).get('player_news', [])
        except: pass
    # ----------------------------------------------------

    team_schedule = get_espn_schedule_data()
    scraped_rosters = scrape_starters()
    
    # Fetch fresh news items 
    all_player_news = scrape_bbm_player_news()
    
    # Filter the FRESH news into Today and Tomorrow buckets
    fresh_today_news = [n for n in all_player_news if n.get('next_game', '').startswith(today_weekday)]
    fresh_tomorrow_news = [n for n in all_player_news if n.get('next_game', '').startswith(tomorrow_weekday)]

    # We scrape BOTH today and tomorrow to ensure both daily files are created
    unique_dates = [current_date_str, tomorrow_str]
    print(f"\n[TIME CHECK] Scraping Today & Tomorrow: {unique_dates}")
        
    dff_projections = {}
    for d_str in unique_dates:
        slate_data = scrape_dff_projections(d_str)
        for player_key, stats in slate_data.items():
            if player_key not in dff_projections:
                dff_projections[player_key] = stats
            else:
                dff_projections[player_key]['fd_slates'].update(stats['fd_slates'])
                dff_projections[player_key]['dk_slates'].update(stats['dk_slates'])
                
                if dff_projections[player_key]['salary'] == 0 and stats['salary'] > 0:
                    dff_projections[player_key].update({k: v for k, v in stats.items() if k in ['salary', 'proj', 'value', 'pos', 'fd_positions', 'injury'] and v})
                if dff_projections[player_key]['dk_salary'] == 0 and stats['dk_salary'] > 0:
                    dff_projections[player_key].update({k: v for k, v in stats.items() if k in ['dk_salary', 'dk_proj', 'dk_value', 'dk_pos', 'dk_positions', 'injury'] and v})

    teams_list = list(scraped_rosters.keys())
    new_games_dict = {}
    formatted_time = et_now.strftime("%b %d, %I:%M %p ET")
    
    print("\n--- MATCHING PLAYERS ---")

    for i in range(0, len(teams_list), 2):
        if i+1 >= len(teams_list): break
        
        team_a = teams_list[i]
        team_b = teams_list[i+1]
        
        team_scheds = team_schedule.get(team_a) or team_schedule.get(team_b, [])
        schedule_info = {}
        if team_scheds:
            today_game = next((s for s in team_scheds if s['date'] == current_date_str), None)
            schedule_info = today_game if today_game else team_scheds[0]
            
        game_date = schedule_info.get("date", current_date_str)
        game_time = schedule_info.get("time", "TBD")
        game_id = f"{team_a}-{team_b}-{game_date}"
        
        # --- START ODDS SHIELD LOGIC ---
        # 1. Fetch fresh event data from ESPN to check for current odds
        fresh_spread = "TBD"
        fresh_total = "TBD"
        espn_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={game_date.replace('-', '')}"
        try:
            res = requests.get(espn_url, timeout=10)
            if res.status_code == 200:
                espn_data = res.json()
                for ev in espn_data.get('events', []):
                    match = False
                    for comp in ev['competitions'][0]['competitors']:
                        if normalize_team(comp['team']['abbreviation']) in [team_a, team_b]:
                            match = True
                            break
                    if match and ev['competitions'][0].get('odds'):
                        odds_data = ev['competitions'][0]['odds'][0]
                        fresh_spread = str(odds_data.get('details', "TBD"))
                        fresh_total = str(odds_data.get('overUnder', "TBD"))
                        break
        except Exception:
            pass

        # 2. Get old odds from cache
        old_game = old_memory.get(game_id, {})
        old_meta = old_game.get("meta", {})
        old_spread = str(old_meta.get("spread", "TBD"))
        old_total = str(old_meta.get("total", "TBD"))
        
        # 3. MAGIC SHIELD: Keep old odds if ESPN dropped them (fresh is TBD but old is real)
        spread_str = old_spread if (fresh_spread == "TBD" and old_spread != "TBD") else fresh_spread
        total_str = old_total if (fresh_total == "TBD" and old_total != "TBD") else fresh_total
        
        if spread_str in ["nan", "+nan", "None"]: spread_str = "TBD"
        if total_str in ["nan", "+nan", "None"]: total_str = "TBD"
        # --- END ODDS SHIELD LOGIC ---

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
            matched_dff_keys = set()
            
            for p_obj in starters_data:
                raw_name = p_obj['name']
                is_verified = p_obj['verified']
                clean = clean_player_name(raw_name)
                
                p_data = {
                    "pos": "Flex", "name": raw_name,
                    "salary": 0, "proj": 0, "value": 0,
                    "dk_pos": "Flex", "dk_salary": 0, "dk_proj": 0, "dk_value": 0,
                    "fd_slates": [], "dk_slates": [],
                    "fd_positions": "", "dk_positions": "",
                    "injury": "", "verified": is_verified 
                }
                
                p_key = f"{team}_{clean}"
                if p_key in dff_projections:
                    matched_dff_keys.add(p_key)
                    dff_p = dff_projections[p_key]
                    p_data.update({
                        "pos": dff_p.get('pos', 'Flex'),
                        "salary": dff_p.get('salary', 0), "proj": dff_p.get('proj', 0), "value": dff_p.get('value', 0),
                        "dk_pos": dff_p.get('dk_pos', 'Flex'),
                        "dk_salary": dff_p.get('dk_salary', 0), "dk_proj": dff_p.get('dk_proj', 0), "dk_value": dff_p.get('dk_value', 0),
                        "fd_slates": dff_p.get('fd_slates', []), "dk_slates": dff_p.get('dk_slates', []),
                        "fd_positions": dff_p.get('fd_positions', ''), "dk_positions": dff_p.get('dk_positions', ''),
                        "injury": dff_p.get('injury', '')
                    })
                else:
                    parts = clean.split()
                    if len(parts) >= 2:
                        last_name = parts[-1]
                        first_initial = parts[0][0]
                        for d_key, d_val in dff_projections.items():
                            if d_key.startswith(f"{team}_") and last_name in d_key and d_key.split('_')[1].startswith(first_initial):
                                matched_dff_keys.add(d_key)
                                p_data.update({
                                    "pos": d_val.get('pos', 'Flex'),
                                    "salary": d_val.get('salary', 0), "proj": d_val.get('proj', 0), "value": d_val.get('value', 0),
                                    "dk_pos": d_val.get('dk_pos', 'Flex'),
                                    "dk_salary": d_val.get('dk_salary', 0), "dk_proj": d_val.get('dk_proj', 0), "dk_value": d_val.get('dk_value', 0),
                                    "fd_slates": d_val.get('fd_slates', []), "dk_slates": d_val.get('dk_slates', []),
                                    "fd_positions": d_val.get('fd_positions', ''), "dk_positions": d_val.get('dk_positions', ''),
                                    "injury": d_val.get('injury', '')
                                })
                                break

                    if p_data["salary"] == 0 and old_game:
                        old_roster = old_game.get('rosters', {}).get(team, {}).get('players', [])
                        for old_p in old_roster:
                            if clean_player_name(old_p['name']) == clean:
                                p_data.update({
                                    "pos": old_p.get("pos", "Flex"),
                                    "salary": old_p.get("salary", 0), "proj": old_p.get("proj", 0), "value": old_p.get("value", 0),
                                    "dk_pos": old_p.get("dk_pos", "Flex"),
                                    "dk_salary": old_p.get("dk_salary", 0), "dk_proj": old_p.get("dk_proj", 0), "dk_value": old_p.get("dk_value", 0),
                                    "fd_slates": old_p.get("fd_slates", []), "dk_slates": old_p.get("dk_slates", []),
                                    "fd_positions": old_p.get("fd_positions", ""), "dk_positions": old_p.get("dk_positions", "")
                                })
                                break
                
                player_list.append(p_data)
            
            if not player_list:
                 player_list.append({"pos": "-", "name": "Waiting for Lineup", "salary": 0, "proj": 0, "value": 0, "dk_pos": "-", "dk_salary": 0, "dk_proj": 0, "dk_value": 0, "fd_slates": [], "dk_slates": [], "fd_positions": "", "dk_positions": "", "injury": "", "verified": False})

            bench_list = []
            for d_key, d_val in dff_projections.items():
                if d_key.startswith(f"{team}_") and d_key not in matched_dff_keys:
                    if d_val.get('salary', 0) > 0 or d_val.get('dk_salary', 0) > 0:
                        bench_list.append({
                            "pos": d_val.get('pos', 'Flex'),
                            "name": d_val.get('name', 'Unknown'),
                            "salary": d_val.get('salary', 0), "proj": d_val.get('proj', 0), "value": d_val.get('value', 0),
                            "dk_pos": d_val.get('dk_pos', 'Flex'),
                            "dk_salary": d_val.get('dk_salary', 0), "dk_proj": d_val.get('dk_proj', 0), "dk_value": d_val.get('dk_value', 0),
                            "fd_slates": d_val.get('fd_slates', []), "dk_slates": d_val.get('dk_slates', []),
                            "fd_positions": d_val.get('fd_positions', ''), "dk_positions": d_val.get('dk_positions', ''),
                            "injury": d_val.get('injury', ''), "verified": False
                        })
            
            bench_list.sort(key=lambda x: max(x.get('proj', 0), x.get('dk_proj', 0)), reverse=True)

            game_obj['rosters'][team] = {
                "logo": f"https://a.espncdn.com/i/teamlogos/nba/500/{team.lower()}.png",
                "players": player_list,
                "bench": bench_list 
            }
            
        new_games_dict[game_id] = game_obj

    for g_id, g_obj in new_games_dict.items():
        old_memory[g_id] = g_obj
        
    games_output = list(old_memory.values())
    for g in games_output: 
        g['sort_index'] = parse_time_to_minutes(g['meta'].get('time', '7:00 PM'))
        
    games_output.sort(key=lambda x: (x['date'], x['sort_index']))
    for g in games_output: 
        if 'sort_index' in g: del g['sort_index']
            
    formatted_slates = {
        "fanduel": [{"id": k, "name": v} for k, v in GLOBAL_SLATES['fanduel'].items()],
        "draftkings": [{"id": k, "name": v} for k, v in GLOBAL_SLATES['draftkings'].items()]
    }

    # ==========================================================
    # --- DATA BUCKETING AND DUAL-WRITE LOGIC ---
    # ==========================================================
    print("\n--- SAVING FILES ---")

    today_games = [g for g in games_output if g['date'] == current_date_str]
    tomorrow_games = [g for g in games_output if g['date'] == tomorrow_str]

    # --- NEW: MERGE THE NEWS BUCKETS ---
    final_today_news = merge_news_lists(old_today_news, fresh_today_news)
    final_tomorrow_news = merge_news_lists(old_tomorrow_news, fresh_tomorrow_news)
    final_legacy_news = merge_news_lists(old_legacy_news, all_player_news)

    # Write 1: Today's Daily File
    today_json = {
        "last_updated": formatted_time,
        "player_news": final_today_news,
        "espn_schedule": fetch_espn_scoreboard(current_espn_date),
        "slates": formatted_slates, 
        "games": today_games
    }
    with open(os.path.join(DATA_DIR, f"{current_date_str}.json"), 'w') as f:
        json.dump(today_json, f, indent=2)
    print(f"✅ Saved Daily JSON: data/{current_date_str}.json ({len(today_games)} games, {len(final_today_news)} news items)")

    # Write 2: Tomorrow's Daily File
    tomorrow_json = {
        "last_updated": formatted_time,
        "player_news": final_tomorrow_news,
        "espn_schedule": fetch_espn_scoreboard(tomorrow_espn_date),
        "slates": formatted_slates,
        "games": tomorrow_games
    }
    with open(os.path.join(DATA_DIR, f"{tomorrow_str}.json"), 'w') as f:
        json.dump(tomorrow_json, f, indent=2)
    print(f"✅ Saved Daily JSON: data/{tomorrow_str}.json ({len(tomorrow_games)} games, {len(final_tomorrow_news)} news items)")

    # Write 3: Legacy JSON (Combines everything)
    legacy_json = {
        "last_updated": formatted_time,
        "player_news": final_legacy_news,
        "slates": formatted_slates,
        "games": games_output
    }
    with open(LEGACY_FILE, 'w') as f:
        json.dump(legacy_json, f, indent=2)
    print(f"✅ Saved Legacy JSON: nba_data.json ({len(games_output)} games)")

if __name__ == "__main__":
    build_json()
