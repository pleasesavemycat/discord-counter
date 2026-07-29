// Optional: register slash commands GLOBALLY (available in every server the
// bot is in, but can take up to ~1 hour to propagate).
//
// You usually don't need this — src/index.js registers commands per-guild on
// startup, which is instant. Use this only for production/global rollout.
//
//   node src/register-commands.js

import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commandData } from "./commands.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

// Derive the application id from the bot's own user record.
const app = await rest.get(Routes.currentApplication());
await rest.put(Routes.applicationCommands(app.id), { body: commandData });

console.log(`Registered ${commandData.length} global command(s) for ${app.name}.`);
