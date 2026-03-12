# scripts/generate_retro_nba_images.py
import json
import os
import urllib.request
import io
from PIL import Image, ImageDraw, ImageFont, ImageOps

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(BASE_DIR, "nba_data.json")
OUTPUT_DIR = os.path.join(BASE_DIR, "retro_social_images")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Define X,Y coordinates on a 1080x1080 canvas
COURT_POSITIONS = {
    "PG": (540, 850),
    "SG": (250, 650),
    "SF": (340, 450),
    "PF": (740, 450),
    "C":  (540, 250)
}
ORDERED_POSITIONS = ["PG", "SG", "SF", "PF", "C"]

def load_court_background():
    # Placeholder: Tan background to simulate hardwood
    return Image.new('RGB', (1080, 1080), color='#D2B48C')

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
    except Exception as e:
        print(f"Failed to process headshot {image_url}: {e}")
        return None

def draw_team_lineup(draw, court_img, team_name, players, font_small):
    header_text = f"{team_name.upper()} STARTING FIVE"
    draw.text((540, 100), header_text, fill="white", anchor="mm")
    
    for idx, pos_name in enumerate(ORDERED_POSITIONS):
        if idx >= len(players): break
        
        p = players[idx]
        p_name = p.get('name', 'UNKNOWN').split(' ')[-1].upper()
        p_coords = COURT_POSITIONS[pos_name]

        avatar_url = p.get('headshot')
        if avatar_url:
            avatar = get_circular_avatar(avatar_url)
            if avatar:
                paste_x = p_coords[0] - 110
                paste_y = p_coords[1] - 110
                court_img.paste(avatar, (paste_x, paste_y), avatar)
            
        label = f"{pos_name}: {p_name}"
        draw.text((p_coords[0], p_coords[1] + 120), label, font=font_small, fill="white", anchor="mm")

def main():
    print(f"--- STARTING GRAPHICS ENGINE ---")
    print(f"Looking for data file at: {DATA_FILE}")
    
    if not os.path.exists(DATA_FILE):
        print(f"❌ ERROR: Could not find the file!")
        print(f"Files currently in your root directory: {os.listdir(BASE_DIR)}")
        return

    with open(DATA_FILE, 'r') as f:
        raw_data = json.load(f)

    # Smart JSON Parsing
    if isinstance(raw_data, dict):
        if "games" in raw_data: games_list = raw_data["games"]
        elif "response" in raw_data: games_list = raw_data["response"]
        elif "data" in raw_data: games_list = raw_data["data"]
        else: games_list = list(raw_data.values())
    else:
        games_list = raw_data

    print(f"✅ Successfully loaded {len(games_list)} games from JSON.")

    font_small = ImageFont.load_default()
    images_created = 0

    for idx, game in enumerate(games_list):
        print(f"\n--- Checking Game {idx+1} ---")
        if not isinstance(game, dict):
            print("⏭️ Skipping: Data is not a dictionary.")
            continue

        fixture_id = game.get('fixture', {}).get('id', game.get('id', f'Unknown_{idx}'))
        print(f"Game ID: {fixture_id}")

        h_lineup = game.get("homeLineup")
        a_lineup = game.get("awayLineup")

        if not h_lineup or not a_lineup:
            print(f"⏭️ Skipping {fixture_id}: Could not find 'homeLineup' or 'awayLineup'. Available keys: {list(game.keys())}")
            continue

        if len(h_lineup) < 5 or len(a_lineup) < 5:
            print(f"⏭️ Skipping {fixture_id}: Not enough players.")
            continue

        print(f"🏀 [{fixture_id}] Lineups confirmed! Generating graphics...")

        for is_home in [True, False]:
            team_key = "homeLineup" if is_home else "awayLineup"
            team_name_key = "home" if is_home else "away"
            
            players = game[team_key][:5]
            
            try:
                teams_block = game.get('teams', {})
                team_info = teams_block.get(team_name_key, teams_block.get(team_name_key + 'Team', {}))
                team_name = team_info.get('name', f"Team {team_name_key}")
            except Exception:
                team_name = "UNKNOWN TEAM"
            
            court_img = load_court_background()
            draw = ImageDraw.Draw(court_img)
            draw_team_lineup(draw, court_img, team_name, players, font_small)
            
            filename = f"{fixture_id}_{team_name_key}.jpg"
            filepath = os.path.join(OUTPUT_DIR, filename)
            court_img.save(filepath, "JPEG", quality=95)
            print(f"💾 Saved successfully: {filename}")
            images_created += 1

    print(f"\n🎉 ENGINE FINISHED! Total images created: {images_created}")

if __name__ == "__main__":
    main()
