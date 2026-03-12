# scripts/generate_retro_nba_images.py
import json
import os
import urllib.request
import io
from PIL import Image, ImageDraw, ImageFont, ImageOps

# --- CONFIGURATION ---
# We use standard library path handling to find the file safely.
# This says: "Go to the directory above this script's directory."
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 1. NEW DATA FILE NAME & LOCATION
DATA_FILE = os.path.join(BASE_DIR, "nba_data.json")

# 2. OUTPUT DIRECTORY LOCATION
OUTPUT_DIR = os.path.join(BASE_DIR, "retro_social_images")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Define X,Y coordinates on a 1080x1080 canvas
COURT_POSITIONS = {
    "PG": (540, 850),  # Bottom Center
    "SG": (250, 650),  # Left Wing
    "SF": (340, 450),  # Inside Key (Left)
    "PF": (740, 450),  # Inside Key (Right)
    "C":  (540, 250)   # Under Basket (Top)
}
ORDERED_POSITIONS = ["PG", "SG", "SF", "PF", "C"]

def load_court_background():
    # Placeholder: In production, load your designated 'court_template.png'
    return Image.new('RGB', (1080, 1080), color='#D2B48C') # Tan

def get_circular_avatar(image_url):
    try:
        req = urllib.request.Request(image_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as url_resp:
            img = Image.open(io.BytesIO(url_resp.read())).convert("RGBA")
        
        # Crop and Make circular
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
    # HEADER: "LAKERS STARTING FIVE"
    header_text = f"{team_name.upper()} STARTING FIVE"
    draw.text((540, 100), header_text, fill="white", anchor="mm")
    
    # Process each of the 5 players in your precise order
    for idx, pos_name in enumerate(ORDERED_POSITIONS):
        p = players[idx]
        p_name = p['name'].split(' ')[-1].upper() # Just Last Name
        p_coords = COURT_POSITIONS[pos_name]

        # Fetch and crop headshot from ESPN URL in JSON
        avatar = get_circular_avatar(p['headshot'])
        if avatar:
            paste_x = p_coords[0] - 110
            paste_y = p_coords[1] - 110
            court_img.paste(avatar, (paste_x, paste_y), avatar)
            
            # Draw label underneath (e.g., "PG: RUSSELL")
            label = f"{pos_name}: {p_name}"
            draw.text((p_coords[0], p_coords[1] + 120), label, font=font_small, fill="white", anchor="mm")

def main():
    if not os.path.exists(DATA_FILE):
        print(f"Error: Could not find data file at {DATA_FILE}")
        return

    with open(DATA_FILE, 'r') as f:
        raw_data = json.load(f)

    # --- THE FIX: Smart JSON Parsing ---
    # Determine how the games are wrapped in the JSON file
    if isinstance(raw_data, dict):
        if "games" in raw_data:
            games_list = raw_data["games"]
        elif "response" in raw_data:
            games_list = raw_data["response"]
        elif "data" in raw_data:
            games_list = raw_data["data"]
        else:
            # If it's a dictionary keyed by game ID (e.g., {"12345": {...}, "67890": {...}})
            games_list = list(raw_data.values())
    else:
        # It's already a flat list
        games_list = raw_data

    # Simplified default font for test
    font_small = ImageFont.load_default()

    for game in games_list:
        # Safety catch: skip anything that isn't a dictionary
        if not isinstance(game, dict):
            continue

        # Check if both teams have full lineups confirmed
        if (game.get("homeLineup") and len(game["homeLineup"]) >= 5 and
            game.get("awayLineup") and len(game["awayLineup"]) >= 5):
            
            fixture_id = game.get('fixture', {}).get('id', 'Unknown')
            print(f"[{fixture_id}] Lineups confirmed. Generating graphics...")

            for is_home in [True, False]:
                team_key = "homeLineup" if is_home else "awayLineup"
                team_name_key = "homeTeam" if is_home else "awayTeam"
                
                # Check if the team structure matches what we expect
                if team_key not in game or team_name_key not in game['teams']:
                    continue
                
                # We assume your first 5 meet the exact ordering (PG, SG, SF, PF, C)
                players = game[team_key][:5] 
                team_name = game['teams'][team_name_key]['name']
                
                # Create court canvas
                court_img = load_court_background()
                draw = ImageDraw.Draw(court_img)
                
                # Draw lineup
                draw_team_lineup(draw, court_img, team_name, players, font_small)
                
                # Save JPG
                filename = f"{fixture_id}_{'home' if is_home else 'away'}.jpg"
                filepath = os.path.join(OUTPUT_DIR, filename)
                court_img.save(filepath, "JPEG", quality=95)



if __name__ == "__main__":
    main()
