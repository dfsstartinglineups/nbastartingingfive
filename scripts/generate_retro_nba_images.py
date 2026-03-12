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

        # Check for lineups
        h_lineup = game.get("homeLineup")
        a_lineup = game.get("awayLineup")

        if not h_lineup or not a_lineup:
            print(f"⏭️ Skipping {fixture_id}: Could not find 'homeLineup' or 'awayLineup'. Available keys: {list(game.keys())}")
            continue

        if len(h_lineup) < 5 or len(a_lineup) < 5:
            print(f"⏭️ Skipping {fixture_id}: Not enough players. (Home: {len(h_lineup)}, Away: {len(a_lineup)})")
            continue

        print(f"🏀 [{fixture_id}] Lineups confirmed! Generating graphics...")

        for is_home in [True, False]:
            team_key = "homeLineup" if is_home else "awayLineup"
            team_name_key = "home" if is_home else "away" # Switched to standard 'home' / 'away'
            
            players = game[team_key][:5]
            
            # Safely get team name
            try:
                teams_block = game.get('teams', {})
                team_info = teams_block.get(team_name_key, teams_block.get(team_name_key + 'Team', {}))
                team_name = team_info.get('name', f"Team {team_name_key}")
            except Exception as e:
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
