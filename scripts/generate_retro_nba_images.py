import json
import os
import urllib.request
import io
import re
from PIL import Image, ImageDraw, ImageFont, ImageOps

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(BASE_DIR, "nba_data.json")
OUTPUT_DIR = os.path.join(BASE_DIR, "retro_social_images")
os.makedirs(OUTPUT_DIR, exist_ok=True)

COURT_POSITIONS = {
    "PG": (540, 850),
    "SG": (250, 650),
    "SF": (340, 450),
    "PF": (740, 450),
    "C":  (540, 250)
}
ORDERED_POSITIONS = ["PG", "SG", "SF", "PF", "C"]

ESPN_TEAM_MAP = {
    "GSW": "GS", "NOP": "NO", "NYK": "NY", "SAS": "SA", "UTA": "UTAH"
}

def normalize_name(name):
    """Strips punctuation, spaces, and suffixes to perfectly match ESPN names to DFS names."""
    name = name.lower()
    name = name.replace("'", "").replace("-", "").replace(".", "").replace(" ", "")
    if name.endswith("jr"): name = name[:-2]
    if name.endswith("sr"): name = name[:-2]
    if name.endswith("iii"): name = name[:-3]
    elif name.endswith("ii"): name = name[:-2]
    return name

def load_court_background():
    # Dark Blue Background
    return Image.new('RGB', (1080, 1080), color='#1D428A') 

def get_fonts():
    """Downloads a professional bold font if it doesn't exist so text isn't microscopic."""
    font_path = os.path.join(BASE_DIR, "Roboto-Bold.ttf")
    if not os.path.exists(font_path):
        print("  📥 Downloading Professional Font...")
        url = "https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Bold.ttf"
        try:
            urllib.request.urlretrieve(url, font_path)
        except Exception:
            return ImageFont.load_default(), ImageFont.load_default()
    
    # Load fonts at massive, highly-readable sizes
    return ImageFont.truetype(font_path, 72), ImageFont.truetype(font_path, 36)

def get_silhouette_avatar():
    img = Image.new('RGBA', (220, 220), color='#444444')
    mask = Image.new('L', img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, img.size[0], img.size[1]), fill=255)
    output = ImageOps.fit(img, mask.size, centering=(0.5, 0.5))
    output.putalpha(mask)
    return output

def fetch_espn_headshots_for_team(team_abbr):
    espn_abbr = ESPN_TEAM_MAP.get(team_abbr, team_abbr).lower()
    url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{espn_abbr}/roster"
    
    headshots = {}
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            for group in data.get('athletes', []):
                for item in group.get('items', []):
                    name = item.get('fullName', '')
                    headshot_url = item.get('headshot', {}).get('href', '')
                    if name and headshot_url:
                        # Normalize the ESPN name so it matches the DFS name perfectly
                        clean_name = normalize_name(name)
                        headshots[clean_name] = headshot_url
    except Exception as e:
        pass
        
    return headshots

def get_circular_avatar(image_url):
    try:
        req = urllib.request.Request(image_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as url_resp:
            img = Image.open(io.BytesIO(url_resp.read())).convert("RGBA")
        
        img = img.resize((220, 220))
        mask = Image.new('L', img.size, 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((0, 0, img.size[0], img.size[1]), fill=255)
        
        output = ImageOps.fit(img, mask.size, centering=(0.5, 0.5))
        output.putalpha(mask)
        return output
    except Exception:
        return get_silhouette_avatar()

def draw_team_lineup(draw, court_img, team_name, players, font_large, font_small, espn_headshots):
    # 1. Manually center the header (Using the LARGE font now)
    header_text = f"{team_name.upper()} STARTING FIVE"
    h_length = draw.textlength(header_text, font=font_large)
    draw.text((540 - (h_length / 2), 60), header_text, font=font_large, fill="white")
    
    for idx, pos_name in enumerate(ORDERED_POSITIONS):
        if idx >= len(players): break
        
        p = players[idx]
        full_name = p.get('name', 'UNKNOWN')
        last_name = full_name.split(' ')[-1].upper()
        p_coords = COURT_POSITIONS[pos_name]

        # Check our dictionary for the ESPN URL using the NORMALIZED name
        clean_name = normalize_name(full_name)
        headshot_url = espn_headshots.get(clean_name)
        
        if headshot_url:
            avatar = get_circular_avatar(headshot_url)
        else:
            avatar = get_silhouette_avatar()
            
        paste_x = p_coords[0] - 110
        paste_y = p_coords[1] - 110
        court_img.paste(avatar, (paste_x, paste_y), avatar)
            
        # 2. Manually center the player labels (Using the SMALL font)
        label = f"{pos_name}: {last_name}"
        l_length = draw.textlength(label, font=font_small)
        draw.text((p_coords[0] - (l_length / 2), p_coords[1] + 120), label, font=font_small, fill="white")
        
    # 3. Manually right-align the watermark
    wm_text = "@nbastartingfive"
    wm_length = draw.textlength(wm_text, font=font_small)
    draw.text((1050 - wm_length, 1030), wm_text, font=font_small, fill="#888")

def main():
    print(f"--- STARTING GRAPHICS ENGINE ---")
    if not os.path.exists(DATA_FILE):
        print(f"❌ ERROR: Could not find {DATA_FILE}")
        return

    with open(DATA_FILE, 'r') as f:
        raw_data = json.load(f)

    games_list = raw_data.get("games", raw_data) if isinstance(raw_data, dict) else raw_data
    print(f"✅ Successfully loaded {len(games_list)} games.")

    # Get our new TrueType fonts!
    font_large, font_small = get_fonts()
    images_created = 0

    for idx, game in enumerate(games_list):
        if not isinstance(game, dict): continue

        fixture_id = game.get('id', f'Unknown_{idx}')
        teams = game.get('teams', [])
        rosters = game.get('rosters', {})
        
        if len(teams) < 2 or not rosters:
            continue
            
        print(f"\n🏀 Processing Game: {fixture_id}")

        for team_abbr in teams:
            team_data = rosters.get(team_abbr, {})
            all_players = team_data.get('players', [])
            
            verified_players = [p for p in all_players if p.get('verified') == True]
            
            if len(verified_players) < 5:
                continue
                
            starting_five = verified_players[:5]
            
            # --- FETCH ESPN HEADSHOTS ---
            print(f"  📡 Fetching ESPN Headshots for {team_abbr}...")
            espn_headshots = fetch_espn_headshots_for_team(team_abbr)
            
            court_img = load_court_background()
            draw = ImageDraw.Draw(court_img)
            draw_team_lineup(draw, court_img, team_abbr, starting_five, font_large, font_small, espn_headshots)
            
            filename = f"{fixture_id}_{team_abbr}.jpg"
            filepath = os.path.join(OUTPUT_DIR, filename)
            court_img.save(filepath, "JPEG", quality=95)
            print(f"  💾 Saved {team_abbr} Lineup: {filename}")
            images_created += 1

    print(f"\n🎉 ENGINE FINISHED! Total images created: {images_created}")

if __name__ == "__main__":
    main()
