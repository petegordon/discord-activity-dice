/**
 * Dice achievements, saved to the player's House Tandem account. Shared by the
 * table (toasts), the server (src/achievements/evaluate.ts runs in the relay
 * room) and housetandem.com, which reads them from GET /api/achievements.
 */
export type AchievementGroup = "firsts" | "streaks" | "matches" | "lifetime";

export type AchievementDef = {
  id: string;
  name: string;
  description: string;
  icon: string;
  group: AchievementGroup;
};

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "first_roll", name: "First Roll", description: "Roll the dice.", icon: "🎲", group: "firsts" },
  { id: "lucky_seven", name: "Lucky Seven", description: "Score a 7.", icon: "7️⃣", group: "firsts" },
  { id: "eleven_heaven", name: "Eleven Heaven", description: "Score an 11.", icon: "✨", group: "firsts" },
  { id: "seeing_double", name: "Seeing Double", description: "Roll any doubles.", icon: "👀", group: "firsts" },
  { id: "snake_eyes", name: "Snake Eyes", description: "Roll double 1s.", icon: "🐍", group: "firsts" },
  { id: "boxcars", name: "Boxcars", description: "Roll double 6s.", icon: "🚃", group: "firsts" },
  { id: "full_set", name: "The Full Set", description: "Roll all six doubles, across any games.", icon: "🎰", group: "firsts" },

  { id: "hot_hand", name: "Hot Hand", description: "Score 3 in a row without passing the dice.", icon: "🔥", group: "streaks" },
  { id: "on_fire", name: "On Fire", description: "Score 5 in a row without passing the dice.", icon: "☄️", group: "streaks" },
  { id: "unstoppable", name: "Unstoppable", description: "Score 8 in a row without passing the dice.", icon: "🚀", group: "streaks" },
  { id: "run_the_table", name: "Run the Table", description: "Win a match without ever passing the dice.", icon: "🧹", group: "streaks" },
  { id: "ice_cold", name: "Ice Cold", description: "Pass the dice 5 turns running without scoring.", icon: "🧊", group: "streaks" },

  { id: "first_win", name: "First Win", description: "Win a match.", icon: "🏆", group: "matches" },
  { id: "high_roller", name: "High Roller", description: "Win a race to 21.", icon: "💰", group: "matches" },
  { id: "comeback", name: "Comeback", description: "Win after trailing by 5 or more.", icon: "🔄", group: "matches" },
  { id: "photo_finish", name: "Photo Finish", description: "Win with the runner-up just one point behind.", icon: "📸", group: "matches" },
  { id: "shutout", name: "Shutout", description: "Win a match with 2 or more players where nobody else scored.", icon: "🚫", group: "matches" },
  { id: "full_table", name: "Full Table", description: "Play a match with 4 or more players.", icon: "👥", group: "matches" },

  { id: "regular", name: "Regular", description: "Play 25 matches.", icon: "🪑", group: "lifetime" },
  { id: "thousand_rolls", name: "Thousand Rolls", description: "Roll the dice 1,000 times.", icon: "🎯", group: "lifetime" },
  { id: "good_company", name: "Good Company", description: "Play matches with 10 different signed-in people.", icon: "🤝", group: "lifetime" },
  { id: "shaker", name: "Shaker", description: "Roll 25 times with your phone as the dice cup.", icon: "📱", group: "lifetime" },
];

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
