import json
import os
import requests
import zoneinfo
from datetime import datetime

# ==========================================================
# --- FOLDER SETUP ---
# ==========================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
LIVE_DIR = os.path.join(DATA_DIR, 'LIVE')

os.makedirs(LIVE_DIR, exist_ok=True)

TEAM_MAP = {
    'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 
    'PHO': 'PHX', 'UT': 'UTA', 'WSH': 'WAS', 'BKO': 'BKN', 'CHO': 'CHA'
}

def normalize_team(abbr):
    if not abbr: return ""
    clean = abbr.strip().upper()
    return TEAM_MAP.get(clean, clean)

def calculate_fpts(stats):
    """Calculates FD and DK Fantasy Points dynamically"""
    try: pts = float(stats.get('PTS', 0))
    except: pts = 0.0
    try: reb = float(stats.get('REB', 0))
    except: reb = 0.0
    try: ast = float(stats.get('AST', 0))
    except: ast = 0.0
    try: blk = float(stats.get('BLK', 0))
    except: blk = 0.0
    try: stl = float(stats.get('STL', 0))
    except: stl = 0.0
    try: to = float(stats.get('TO', 0))
    except: to = 0.0
    
    try: threepm = float(stats.get('3PT', '0-0').split('-')[0])
    except: threepm = 0.0

    fd_pts = pts + (reb * 1.2) + (ast * 1.5) + (blk * 3) + (stl * 3) - to
    dk_pts = pts + (threepm * 0.5) + (reb * 1.25) + (ast * 1.5) + (blk * 2) + (stl * 2) - (to * 0.5)
    
    doubles = sum(1 for stat in [pts, reb, ast, blk, stl] if stat >= 10)
    if doubles >= 3: dk_pts += 3.0 
    elif doubles == 2: dk_pts += 1.5 

    return round(fd_pts, 2), round(dk_pts, 2)

def fuzzy_match_player(pbp_name, roster_names):
    """
    Matches ESPN play-by-play names to full boxscore names.
    Since we now know ESPN uses full names in the PBP, we prioritize exact matches!
    """
    clean_pbp = pbp_name.replace('.', '').strip().lower()

    # 1. Try an exact match first (This will hit 99% of the time based on the logs!)
    for full_name in roster_names:
        if clean_pbp == full_name.replace('.', '').strip().lower():
            return full_name
            
    # 2. Fallback: Substring match (e.g., "Tim Hardaway" vs "Tim Hardaway Jr.")
    for full_name in roster_names:
        clean_full = full_name.replace('.', '').strip().lower()
        if clean_pbp in clean_full or clean_full in clean_pbp:
            return full_name
            
    # 3. Last Resort: Initial + Last Name match (just in case ESPN abbreviates suddenly)
    parts = clean_pbp.split(' ')
    if len(parts) > 1:
        last_name = parts[-1]
        first_initial = parts[0][0]
        for full_name in roster_names:
            clean_full = full_name.replace('.', '').strip().lower()
            full_parts = clean_full.split(' ')
            if full_parts[-1] == last_name and clean_full.startswith(first_initial):
                return full_name
                
    return None

def main():
    ny_tz = zoneinfo.ZoneInfo("America/New_York")
    now_est = datetime.now(ny_tz)
    
    current_date_str = now_est.strftime("%Y-%m-%d")
    espn_date_str = now_est.strftime("%Y%m%d")
    
    base_file_path = os.path.join(DATA_DIR, f"{current_date_str}.json")
    live_file_path = os.path.join(LIVE_DIR, f"live_{current_date_str}.json")
    
    # 1. Fetch live ESPN Scoreboard
    scoreboard_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={espn_date_str}"
    try:
        sb_res = requests.get(scoreboard_url, timeout=10)
        scoreboard_data = sb_res.json()
    except Exception as e:
        print(f"Failed to fetch ESPN scoreboard: {e}")
        return

    # 2. Load Base JSON (for Tip-Off Starters Seed)
    base_json = {}
    if os.path.exists(base_file_path):
        try:
            with open(base_file_path, 'r') as f:
                base_json = json.load(f)
        except: pass
        
    def get_base_starters(local_game_id, team_side):
        starters = set()
        game_data = next((g for g in base_json.get('games', []) if g['id'] == local_game_id), None)
        if game_data:
            key = 'homeStarters' if team_side == 'home' else 'awayStarters'
            for s in game_data.get(key, []):
                starters.add(s.get('athlete', {}).get('displayName', ''))
        return list(starters)

    new_live_data = {}
    active_games_found = 0

    for event in scoreboard_data.get('events', []):
        status_state = event['status']['type']['state']
        
        if status_state in ['in', 'post']:
            game_id = event['id']
            comp = event['competitions'][0]
            
            home_abbr = normalize_team(comp['competitors'][0]['team']['abbreviation'])
            away_abbr = normalize_team(comp['competitors'][1]['team']['abbreviation'])
            local_game_id = f"{away_abbr}-{home_abbr}-{current_date_str}"
            
            clock_text = event['status']['type']['shortDetail']
            
            # Grabbing the live scores directly from the ESPN scoreboard event
            away_score = comp['competitors'][1].get('score', '0')
            home_score = comp['competitors'][0].get('score', '0')
            
            print(f"Processing Live Game (Play-by-Play Engine): {away_abbr} {away_score} @ {home_score} {home_abbr} ({clock_text})")
            active_games_found += 1
            
            # ... FETCH BOXSCORE ...
            summary_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={game_id}"
            try:
                sum_res = requests.get(summary_url, timeout=10)
                box_data = sum_res.json()
            except: continue
            
            # ... FETCH PLAY-BY-PLAY ...
            pbp_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/playbyplay?event={game_id}"
            try:
                pbp_res = requests.get(pbp_url, timeout=10)
                pbp_data = pbp_res.json()
            except: 
                pbp_data = {}

            game_live_obj = {
                "status": status_state,
                "clock": clock_text,
                "away_score": away_score, # <--- NEW LIVE SCORE
                "home_score": home_score, # <--- NEW LIVE SCORE
                "team_stats": {},
                "players": {home_abbr: {}, away_abbr: {}}
            }
            
            # =========================================================
            # THE PLAY-BY-PLAY STATE MACHINE
            # =========================================================
            home_starters = get_base_starters(local_game_id, 'home')
            away_starters = get_base_starters(local_game_id, 'away')
            
            on_court_tracker = {
                home_abbr: set(home_starters),
                away_abbr: set(away_starters)
            }
            
            # Build full roster lists for fuzzy matching
            rosters = {home_abbr: [], away_abbr: []}
            if 'boxscore' in box_data and 'players' in box_data['boxscore']:
                for team_box in box_data['boxscore']['players']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if t_abbr in rosters and team_box.get('statistics'):
                        for ath in team_box['statistics'][0].get('athletes', []):
                            rosters[t_abbr].append(ath['athlete']['displayName'])

            plays = pbp_data.get('items', [])
            # Sort plays chronologically
            plays = sorted(plays, key=lambda x: float(x.get('sequenceNumber', 0)))
            
            for play in plays:
                text = play.get('text', '')
                if ' enters the game for ' in text:
                    parts = text.split(' enters the game for ')
                    if len(parts) == 2:
                        p_in_short = parts[0].strip()
                        p_out_short = parts[1].strip()
                        
                        # Determine which team made the sub by checking the roster
                        for t_abbr in [home_abbr, away_abbr]:
                            p_in_full = fuzzy_match_player(p_in_short, rosters[t_abbr])
                            p_out_full = fuzzy_match_player(p_out_short, rosters[t_abbr])
                            
                            if p_in_full or p_out_full:
                                if p_in_full: on_court_tracker[t_abbr].add(p_in_full)
                                if p_out_full: on_court_tracker[t_abbr].discard(p_out_full)
                                break # Found the team, move to next play

            # =========================================================
            # BUILD BOXSCORE JSON WITH NEW ON-COURT FLAGS
            # =========================================================
            if 'boxscore' in box_data and 'players' in box_data['boxscore']:
                for team_box in box_data['boxscore']['players']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    stat_labels = team_box['statistics'][0]['names']
                    team_athletes = team_box['statistics'][0]['athletes']
                    
                    for ath in team_athletes:
                        if not ath.get('stats'): continue
                        p_name = ath['athlete']['displayName']
                        mapped_stats = dict(zip(stat_labels, ath['stats']))
                        
                        try: current_mins = int(mapped_stats.get('MIN', 0))
                        except: current_mins = 0
                        
                        # Apply the parsed text logic!
                        is_on_court = p_name in on_court_tracker[t_abbr]
                        
                        # Failsafe: If they are on the court tracker but have 0 boxscore minutes and aren't starters, 
                        # they might be a ghost string. We leave them on court to let JS handle it.
                                
                        fd_pts, dk_pts = calculate_fpts(mapped_stats)
                        
                        game_live_obj["players"][t_abbr][p_name] = {
                            "MIN": current_mins,
                            "PTS": mapped_stats.get("PTS", "0"),
                            "REB": mapped_stats.get("REB", "0"),
                            "AST": mapped_stats.get("AST", "0"),
                            "STL": mapped_stats.get("STL", "0"),
                            "BLK": mapped_stats.get("BLK", "0"),
                            "TO": mapped_stats.get("TO", "0"),
                            "FG": mapped_stats.get("FG", "0-0"),
                            "3PT": mapped_stats.get("3PT", "0-0"),
                            "FT": mapped_stats.get("FT", "0-0"),
                            "fd_pts": fd_pts,
                            "dk_pts": dk_pts,
                            "is_on_court": is_on_court
                        }
                        
            # Grab Team Stats
            if 'boxscore' in box_data and 'teams' in box_data['boxscore']:
                for team_box in box_data['boxscore']['teams']:
                    t_abbr = normalize_team(team_box['team']['abbreviation'])
                    if not team_box.get('statistics'): continue
                    
                    team_stats_dict = {}
                    for stat_obj in team_box['statistics']:
                        stat_key = stat_obj.get('abbreviation', stat_obj.get('name', ''))
                        stat_val = stat_obj.get('displayValue', '')
                        if stat_key:
                            team_stats_dict[stat_key] = stat_val
                            
                    game_live_obj["team_stats"][t_abbr] = team_stats_dict

            new_live_data[local_game_id] = game_live_obj

    if active_games_found > 0:
        with open(live_file_path, 'w') as f:
            json.dump(new_live_data, f, indent=2)
        print(f"\n✅ Successfully updated {live_file_path} with {active_games_found} active games.")
    else:
        print("\n💤 No active games right now. Script exiting cleanly.")

if __name__ == "__main__":
    main()
