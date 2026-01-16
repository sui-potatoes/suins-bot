// Copyright (c) Sui Potatoes
// SPDX-License-Identifier: MIT

import { Bot, Context, InlineKeyboard, session } from "grammy";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs, BcsStruct } from "@mysten/sui/bcs";
import { formatAddress, isValidSuiAddress, toHex } from "@mysten/sui/utils";
import { NameRecord } from "@mysten/sui/dist/cjs/grpc/proto/sui/rpc/v2/name_service";
import Redis from "ioredis";

// === Constants ===

// Set this environment variable in for the process.
const BOT_TOKEN = process.env.NS_BOT_TOKEN;

// prettier-ignore
const NS_OBJECT_TYPE = "0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration";

// Early abort if ENV is not set.
if (!BOT_TOKEN) {
	console.error("Set `NS_BOT_TOKEN` env variable to get it working");
	process.exit(1);
}

// === Callback keys ===

const SEARCH_ADDRESS = "track-address";
const SEARCH_NAME = "track-name";
const MY_TRACKERS = "my-trackers";
const ANOTHER_SEARCH = "another-search";
const TRACK_NAME = "notify-name";
const STOP_TRACKING_NAME = "stop-tracking-name";

// === Redis Keys ===

// const REDIS_USER_TRACKERS = 'chat_id:tracker';
const REDIS_ALL_TRACKED_NAMES = "all_tracked_names";
const REDIS_TRACKED_NAMES = "names:chat_id"; // used as chat_id:names:${id} -> tracked_name[]
const REDIS_CHAT_IDS = "all_chat_ids";
// Stores last notification level sent: `notifications:${chatId}:${name}` -> "30d" | "14d" | "3d" | "expired"
const REDIS_NOTIFICATION_LEVEL = "notifications";

// === Types ===

// List of keys for callback queries.
type WaitKeys = "track-address:address" | "track-name:name";

// Extends default context with Session variables.
type MyContext = {
	session: {
		waitingFor: null | WaitKeys;
		recentLookup: null | string;
		triedUnknownCommand: boolean;
		notifyFor: null | NameRecord;
		myNames: null | string[];
		reset: () => void;
	};
};

// Features:
// - track a single name, get updates 30 days, 2 weeks, 3 days + on the day of expiration
//   allow turning off tracking in the message
//
// - track all names for a single address, notify when any is nearing expiration
//   ...probably store the names in the DB and refresh them each time when user
//   ...queries their names (maybe?)
//
// Notes:
// - track `lastNotificationTimestamp` for each user to prevent
// - maybe simply create a timed queue instead of going through all addresses?
// - track keys structure: user_id:name:timestamp
// - a separate index per user to

type TrackedNames = string[];

type TrackerRecord = {};

// === BCS Types ===

const SuinsRegistration = bcs.struct("SuinsRegistration", {
	id: bcs.Address,
	domain: bcs.vector(bcs.string()),
	domain_name: bcs.string(),
	expires_at: bcs.u64(),
	image_url: bcs.string(),
});

// === Main App ===

// Uses REDIS_URL env var or defaults to localhost
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// Sui GRPC connection, should be an env variable...
const grpc = new SuiGrpcClient({
	network: "mainnet",
	baseUrl: "https://fullnode.mainnet.sui.io",
});

// Telegram Bot API
const bot = new Bot<Context & MyContext>(BOT_TOKEN);

// Notification levels in order of urgency
type NotificationLevel = "30d" | "14d" | "3d" | "1d" | "expired";
const NOTIFICATION_THRESHOLDS: { level: NotificationLevel; days: number }[] = [
	{ level: "30d", days: 30 },
	{ level: "14d", days: 14 },
	{ level: "3d", days: 3 },
	{ level: "1d", days: 1 },
	{ level: "expired", days: 0 },
];

/**
 * Determines the notification level based on days until expiration.
 */
function getNotificationLevel(daysLeft: number): NotificationLevel | null {
	for (const { level, days } of NOTIFICATION_THRESHOLDS) {
		if (daysLeft <= days) {
			return level;
		}
	}
	return null;
}

/**
 * Get the priority of a notification level (higher = more urgent).
 */
function getLevelPriority(level: NotificationLevel): number {
	const priorities: Record<NotificationLevel, number> = {
		"30d": 1,
		"14d": 2,
		"3d": 3,
		"1d": 4,
		expired: 5,
	};
	return priorities[level];
}

/**
 * Check if we should send a notification based on the last sent level.
 */
async function shouldNotify(
	chatId: string,
	name: string,
	currentLevel: NotificationLevel,
): Promise<boolean> {
	const key = `${REDIS_NOTIFICATION_LEVEL}:${chatId}:${name}`;
	const lastLevel = (await redis.get(key)) as NotificationLevel | null;

	if (!lastLevel) return true;

	// Only notify if current level is more urgent than last sent
	return getLevelPriority(currentLevel) > getLevelPriority(lastLevel);
}

/**
 * Mark that we've sent a notification at this level.
 */
async function markNotificationSent(
	chatId: string,
	name: string,
	level: NotificationLevel,
): Promise<void> {
	const key = `${REDIS_NOTIFICATION_LEVEL}:${chatId}:${name}`;
	// Expire after 60 days to clean up old entries
	await redis.set(key, level, "EX", 60 * 24 * 3600);
}

/**
 * Generate notification message based on days left.
 */
function getNotificationMessage(name: string, daysLeft: number, expirationDate: Date): string {
	const formattedName = formatName(name);
	const dateStr = expirationDate.toUTCString();

	if (daysLeft <= 0) {
		return `🚨 *EXPIRED*: Your name ${formattedName} has expired!\n\nExpired on: ${dateStr}\n\nRenew it now at [suins.io](https://suins.io/) before someone else registers it!`;
	}
	if (daysLeft <= 1) {
		return `🔴 *URGENT*: Your name ${formattedName} expires TOMORROW!\n\nExpires: ${dateStr}\n\nRenew at [suins.io](https://suins.io/)`;
	}
	if (daysLeft <= 3) {
		return `🟠 *Warning*: Your name ${formattedName} expires in ${daysLeft} days!\n\nExpires: ${dateStr}\n\nRenew at [suins.io](https://suins.io/)`;
	}
	if (daysLeft <= 14) {
		return `🟡 *Reminder*: Your name ${formattedName} expires in ${daysLeft} days.\n\nExpires: ${dateStr}\n\nConsider renewing at [suins.io](https://suins.io/)`;
	}
	return `📅 *Heads up*: Your name ${formattedName} expires in ${daysLeft} days.\n\nExpires: ${dateStr}\n\nYou can renew anytime at [suins.io](https://suins.io/)`;
}

/**
 * Main notification loop - runs periodically to check expirations.
 */
async function runNotificationLoop(): Promise<void> {
	console.log("[Notifications] Starting notification check...");

	const trackers = await getAllNameTrackers();

	for (const [chatId, names] of trackers) {
		for (const name of names) {
			try {
				const record = await getNameRecord(name);

				if (!record || !record.expirationTimestamp) {
					console.log(`[Notifications] Skipping ${name} - no record found`);
					continue;
				}

				const expirationMs = +record.expirationTimestamp.seconds.toString() * 1000;
				const expirationDate = new Date(expirationMs);
				const daysLeft = Math.floor((expirationMs - Date.now()) / (24 * 3600 * 1000));

				const level = getNotificationLevel(daysLeft);

				if (!level) {
					// More than 30 days left, no notification needed
					continue;
				}

				if (await shouldNotify(chatId, name, level)) {
					const message = getNotificationMessage(name, daysLeft, expirationDate);

					const kb = new InlineKeyboard()
						.text(`Stop tracking ${formatName(name)}`, `${STOP_TRACKING_NAME}:inline:${name}`)
						.row()
						.text("View all trackers", MY_TRACKERS);

					await bot.api.sendMessage(chatId, message, {
						parse_mode: "Markdown",
						reply_markup: kb,
						link_preview_options: { is_disabled: true },
					});

					await markNotificationSent(chatId, name, level);
					console.log(`[Notifications] Sent ${level} notification to ${chatId} for ${name}`);
				}
			} catch (error) {
				console.error(`[Notifications] Error processing ${name} for chat ${chatId}:`, error);
			}
		}
	}

	console.log("[Notifications] Notification check complete.");
}

// Start notification loop - check every hour
const NOTIFICATION_INTERVAL = 60 * 60 * 1000; // 1 hour
setInterval(runNotificationLoop, NOTIFICATION_INTERVAL);
// Run once on startup after a short delay
setTimeout(runNotificationLoop, 5000);

// Set initial state of the session.
bot.use(
	session({
		initial: () => ({
			waitingFor: null as null | WaitKeys,
			recentLookup: null as null | string,
			triedUnknownCommand: false as boolean,
			notifyFor: null as null | NameRecord,
			myNames: null as null | string[],
			reset() {
				this.notifyFor = null;
				this.recentLookup = null;
				this.triedUnknownCommand = false;
				this.notifyFor = null;
				this.myNames = null;
			},
		}),
	}),
);

bot.command("help", (ctx) => {
	// prettier-ignore
	ctx.reply(
		"Hi there!\n\n" +
		"Suins Buddy is there to help you track your SuiNS names' expiration dates and not miss the opportunity to renew. It can also be used to try and catch someone else's name if its nearing expiration - fair game!\n" +
		"\nTo use it simply press /start, the rest is self-explanatory" +
		"\nOther available commands are:\n- /privacy\n- /developer_info\n- /help (this message)"
	);
});

bot.command("developer_info", (ctx) => {
	// prettier-ignore
	ctx.reply(
		"Created by Sui Potatoes\n" +
		"Contact: support@example.com\n" +
		"GitHub: https://github.com/sui-potatoes\n" +
		"Source Code: https://github.com/sui-potatoes/suins-bot\n",
	);
});

bot.command("privacy", (ctx) => {
	// prettier-ignore
	ctx.reply(
		`This bot stores only the minimum data required to function.

What is stored:
• Chat ID (used to send reminders and notifications)
• Tracked names and addresses you explicitly subscribe to

What is NOT stored:
• Message history
• Search queries
• User profiles or personal identifiers beyond chat ID

Data usage:
• Data is used only to provide reminders and tracking features
• No data is shared with third parties
• No payments or advertising are involved

Data removal:
• You can request deletion of your data at any time, use /delete
• Tracked items are removed immediately upon request
`
	);
});

bot.command("delete", async (ctx) => {
	const nameKeys = await redis.keys(`${REDIS_TRACKED_NAMES}:${ctx.chatId}`);
	await redis.del(nameKeys);

	ctx.reply(
		"All name tracking records are deleted. If you clear this chat, there will be no trace of us ever interacting",
	);
});

// Scenario:
// 1. /start
//
// Session:
// - if `triedUnknownCommand` is set, unset + use a different message
//
// Expects:
// - none
bot.command("start", async (ctx) => {
	// Repeated interaction with the bot.
	if (await redis.sismember(REDIS_CHAT_IDS, ctx.chatId!.toString())) {
		const baseMessage = "Good to see you again. What shall we do?";
		return ctx.reply(baseMessage, { reply_markup: defaultKeyboard() });
	}

	const baseMessage = !!ctx.session.triedUnknownCommand
		? "I'm glad you learned how to interact with me!"
		: "Hello, friend. I'm your SuiNS buddy - I can track yours and others' names and notify when they're nearing expiration";

	await ctx.reply(`${baseMessage}\n\nWhat would you like me to do?`, {
		reply_markup: defaultKeyboard(),
	});
});

// Scenario:
// 1. /start
// 2. perform search
// 3. click on "another search"
//
// Session:
// - none
//
// Expects:
// - none
bot.callbackQuery(ANOTHER_SEARCH, async (ctx) => {
	const baseMessage = `What now?`;
	const kb = defaultKeyboard();

	await ctx.reply(`${baseMessage}\n`, {
		reply_markup: kb,
	});

	await ctx.answerCallbackQuery();
});

/**
 * Scenario:
 * 1. /start
 * 2. inline-button: SEARCH_ADDRESS
 *
 * Session:
 * - waitingFor: `track-address:address`
 *
 * Expects:
 * - none
 */
bot.callbackQuery(SEARCH_ADDRESS, async (ctx) => {
	await ctx.reply(
		"Enter an address either as a reply or in a message. Either plain address, or a suins name prefixed with `@` sign",
	);

	ctx.session.waitingFor = "track-address:address";

	await ctx.answerCallbackQuery();
});

/**
 * Scenario:
 * 1. Click any `My Trackers` button
 *
 * Session:
 * - none
 *
 * Expects:
 * - none
 */
bot.callbackQuery(MY_TRACKERS, async (ctx) => {
	if (!ctx.chatId) {
		return ctx.answerCallbackQuery("Something went terribly wrong!");
	}

	const names = await getTrackedNames(ctx.chatId!);

	ctx.session.myNames = names;
	ctx.answerCallbackQuery("Looking up stored trackers...");

	const kb = new InlineKeyboard();
	let reply = "Your tracked names:\n\n";
	for (let i = 0; i < names.length; i++) {
		const key = names[i]!;
		const record = await getNameRecord(key);

		let info = "";
		if (record?.expirationTimestamp) {
			const expirationMs = +record.expirationTimestamp.seconds.toString() * 1000;
			const daysLeft = Math.floor((expirationMs - Date.now()) / (24 * 3600 * 1000));

			// Get last notification level sent
			const lastLevel = (await redis.get(
				`${REDIS_NOTIFICATION_LEVEL}:${ctx.chatId}:${key}`,
			)) as NotificationLevel | null;

			// Calculate next notification
			let nextNotification = "";
			if (daysLeft <= 0) {
				nextNotification = "expired";
			} else {
				// Find next threshold that hasn't been notified yet
				const thresholdDays = [30, 14, 3, 1, 0];
				const lastPriority = lastLevel ? getLevelPriority(lastLevel) : 0;

				for (const threshold of thresholdDays) {
					const level = getNotificationLevel(threshold) as NotificationLevel;
					if (getLevelPriority(level) > lastPriority && daysLeft > threshold) {
						// Next notification will be when daysLeft reaches this threshold
						const notifyInDays = daysLeft - threshold;
						nextNotification = notifyInDays === 0 ? "today" : `in ${notifyInDays}d`;
						break;
					} else if (getLevelPriority(level) > lastPriority && daysLeft <= threshold) {
						// Already past this threshold, notification pending
						nextNotification = "pending";
						break;
					}
				}
			}

			info = ` (${daysLeft}d left, notify ${nextNotification})`;
		}

		reply += `- ${formatName(key)}${info}\n`;
		kb.text(
			`Stop tracking ${formatName(key)}`,
			`${STOP_TRACKING_NAME}:${i}`,
		).row();
	}

	kb.text("Search names or accounts", ANOTHER_SEARCH);

	await ctx.reply(reply, { reply_markup: kb });
});

/**
 * Scenario:
 * 1. /start
 * 2. inline-button: SEARCH_NAME
 *
 * Session:
 * - waitingFor: `track-name:name`
 *
 * Expects:
 * - none
 */
bot.callbackQuery(SEARCH_NAME, async (ctx) => {
	await ctx.reply(
		"Enter a name prefixed with `@` sign or ending with `.sui`",
	);

	ctx.session.waitingFor = "track-name:name";

	await ctx.answerCallbackQuery();
});

/**
 * Scenario:
 * 1. /start
 * 2. track names for address
 * 3. name found but not configured
 * 4. owner found
 * 5. see owner's names
 *
 * Session:
 * - unset `recentLookup`
 *
 * Expects:
 * - `recentLookup`
 */
bot.callbackQuery(`${SEARCH_ADDRESS}:recent`, async (ctx) => {
	await ctx.reply(
		"Enter an address either as a reply or in a message. Either plain address, or a suins name prefixed with `@` sign",
	);

	ctx.session.waitingFor = "track-address:address";

	await ctx.answerCallbackQuery();
});

/**
 * Scenario:
 * 1. /start
 * 2. track single name
 * 3. hit subscribe to updates
 *
 * Session:
 * - unset `notifyFor`
 *
 * Expects:
 * - `notifyFor`
 */
bot.callbackQuery(TRACK_NAME, async (ctx) => {
	const record = ctx.session.notifyFor;

	if (!ctx.session.notifyFor || !ctx.chatId || !record?.name) {
		return ctx.answerCallbackQuery("Something is off");
	}

	const alreadyTracking = await redis.sismember(
		`${REDIS_TRACKED_NAMES}:${ctx.chatId}`,
		record.name,
	);

	if (alreadyTracking) {
		return ctx.answerCallbackQuery("Already tracking this name");
	}

	await redis.sadd(`${REDIS_TRACKED_NAMES}:${ctx.chatId}`, record.name);
	await redis.sadd(REDIS_ALL_TRACKED_NAMES, record.name);
	await redis.sadd(REDIS_CHAT_IDS, ctx.chatId);

	await ctx.answerCallbackQuery("Tracker set");

	const kb = new InlineKeyboard()
		.text("My trackers", MY_TRACKERS)
		.row()
		.text("Search another", ANOTHER_SEARCH);

	await ctx.reply(
		`Now tracking ${formatName(record.name)}. You'll be notified when it's nearing expiration.`,
		{ reply_markup: kb },
	);
});

/**
 * Stop tracking from "My Trackers" menu (uses session index).
 */
bot.callbackQuery(new RegExp(`^${STOP_TRACKING_NAME}:(\\d+)$`), async (ctx) => {
	if (!ctx.session.myNames || !ctx.chatId) {
		return ctx.answerCallbackQuery(
			"Unable to get session data, try again?",
		);
	}

	const [_full, idx] = ctx.match;
	const name = ctx.session.myNames[+idx!];

	if (!name) {
		return ctx.answerCallbackQuery("Name not found in session");
	}

	await stopTracking(ctx.chatId.toString(), name);
	await ctx.answerCallbackQuery("Tracker removed!");
	return ctx.reply(`No longer tracking ${formatName(name)}. Continue or use /start`, {
		reply_markup: defaultKeyboard(),
	});
});

/**
 * Stop tracking from notification message (uses name directly).
 */
bot.callbackQuery(new RegExp(`^${STOP_TRACKING_NAME}:inline:(.+)$`), async (ctx) => {
	if (!ctx.chatId) {
		return ctx.answerCallbackQuery("Something went wrong");
	}

	const [_full, name] = ctx.match;

	if (!name) {
		return ctx.answerCallbackQuery("Name not found");
	}

	await stopTracking(ctx.chatId.toString(), name);
	// Also clear the notification level so they can re-subscribe fresh
	await redis.del(`${REDIS_NOTIFICATION_LEVEL}:${ctx.chatId}:${name}`);

	await ctx.answerCallbackQuery("Tracker removed!");
	return ctx.reply(`No longer tracking ${formatName(name)}. Continue or use /start`, {
		reply_markup: defaultKeyboard(),
	});
});

/**
 * Scenario:
 * 1. User reacts to a message with thumbs up
 *
 * Session:
 * - none
 *
 * Expects:
 * - none
 */
bot.reaction("👍", async (ctx) => {
	const reaction = ctx.update.message_reaction;

	if (!reaction.message_id) {
		return;
	}

	const reply = [
		"I think we can be friends",
		"Yay, you're great too",
		"How sweet of you",
		"I live to serve",
		"I like you too!",
		"Don't forget to tell your friends!",
	].sort(() => Math.random() - 0.5)[0]!;

	ctx.reply(reply);
});

/**
 * Scenario:
 * 1. Incoming message from user
 *
 * Sets:
 * - unset `waitingFor`
 *
 * Expects:
 * - `waitingFor` ctx
 */
bot.on("message", async (ctx) => {
	// Scenario:
	// 1. /start
	// 2. track-name
	// 3. input message
	if (ctx.session.waitingFor === "track-name:name") {
		ctx.session.waitingFor = null;

		const text = ctx.message.text?.trim();

		if (!text) {
			return ctx.reply("Didn't get that. Try sending text next time?");
		}

		const record = await getNameRecord(text);

		if (!record) {
			return ctx.reply(
				"This name is not taken. [Want to get it?](https://suins.io/)\n\nUse /start to search again",
				{ parse_mode: "Markdown" },
			);
		}
		const expirationDate = new Date(
			+record.expirationTimestamp!.seconds.toString() * 1000,
		);

		const { targetAddress, registrationNftId: objectId } = record;

		const targetAddressLink = `[${formatAddress(
			targetAddress || "",
		)}](https://suiscan.xyz/mainnet/account/${targetAddress})`;

		const objectIdLink = `[${formatAddress(
			objectId || "",
		)}](https://suiscan.xyz/mainnet/object/${objectId})`;

		const owner = objectId ? await getObjectOwner(objectId) : null;
		const ownerLink = `[${formatAddress(
			owner || "",
		)}](https://suiscan.xyz/mainnet/account/${owner}`;

		let reply = "";

		reply += `Name: \`${formatName(record.name!)}\`\n`;
		reply += `Expires at: ${expirationDate.toUTCString()}\n`;
		reply += `Owner: ${(owner && ownerLink) || "unable to determine"}\n`;
		reply += `Target address: ${
			(targetAddress && targetAddressLink) || "not set"
		}\n`;
		reply += `Object ID: ${
			(objectId && objectIdLink) || "none (leaf record)"
		}\n`;

		// Set session key for Name Record.
		ctx.session.notifyFor = record;

		const kb = new InlineKeyboard()
			.text("Track expiration", TRACK_NAME)
			.text("Another search", ANOTHER_SEARCH)
			.row()
			.text("My trackers", "my-trackers");

		return ctx.reply(reply, {
			parse_mode: "Markdown",
			reply_markup: kb,
			link_preview_options: { is_disabled: true },
		});
	}

	// Scenario:
	// 1. /start
	// 2. track-address
	// 3. input message
	if (ctx.session.waitingFor === "track-address:address") {
		ctx.session.waitingFor = null;

		const text = ctx.message.text?.trim();

		if (!text) {
			return ctx.reply(
				"Failed to read text. Try again, but this time be nice",
			);
		}

		if (text.startsWith("0x") && isValidSuiAddress(text)) {
			ctx.reply(
				"Okay, this is a sui address, gut. Let me fetch all names for you",
			);

			const names = await getSuinsNamesForAddress(text, null);

			if (names === null) {
				return ctx.reply(
					`Something is off, unable to find this address`,
				);
			}

			const { header, chunks, footer } = prettyPrintListOfNames(
				text,
				names,
			);

			let footerSet = false;

			if (chunks.length > 0) {
				chunks[0] = `${header}\n${chunks[0]}`;
				const lastIdx = chunks.length - 1;
				chunks[lastIdx] += `\n${footer}`;
				footerSet = true;
			} else {
				await ctx.reply(header);
			}

			for (let reply of chunks) {
				await ctx.reply(reply, {
					parse_mode: "MarkdownV2",
					link_preview_options: { is_disabled: true },
				});
			}

			if (!footerSet) {
				await ctx.reply(footer);
			}

			return ctx.reply("Are you happy now, luv? Give me a thumbs up");
		} else {
			const record = await getNameRecord(text);

			if (!record) {
				return ctx.reply(
					"This name is not taken. [Want to get it first?](https://suins.io/)\n\nUse /start to search again",
					{ parse_mode: "Markdown" },
				);
			}

			if (!record.targetAddress) {
				if (!record.registrationNftId) {
					return ctx.reply(
						"This appears to be a leaf name without owner. Try searching for a higher level name? /start",
					);
				}

				const owner = await getObjectOwner(record.registrationNftId);
				const message = !!owner
					? "Name is already taken but not configured. Want to see owner's names?"
					: "Name is already taken but not configured. The object is either wrapped or used in a dapp";

				// TODO: allow searching other suins names of the owner
				await ctx.reply(message, { parse_mode: "Markdown" });

				ctx.session.recentLookup = owner;

				let kb = new InlineKeyboard()
					.text(
						"Track names for this address",
						`${SEARCH_ADDRESS}:recent`,
					)
					.row()
					.text("Start over", "start");

				return ctx.reply("What now?", { reply_markup: kb });
			}

			const address = record.targetAddress;
			const names = await getSuinsNamesForAddress(address, null);

			if (names === null) {
				return ctx.reply(
					`Something is off, unable to find this address`,
				);
			}

			const { header, chunks, footer } = prettyPrintListOfNames(
				address,
				names,
			);

			let footerSet = false;

			if (chunks.length > 0) {
				chunks[0] = `${header}${chunks[0]}`;
				const lastIdx = chunks.length - 1;
				chunks[lastIdx] += `${footer}`;
				footerSet = true;
			} else {
				await ctx.reply(header);
			}

			for (let reply of chunks) {
				await ctx.reply(reply, {
					parse_mode: "MarkdownV2",
					link_preview_options: { is_disabled: true },
				});
			}

			if (!footerSet) {
				await ctx.reply(footer);
			}

			return ctx.reply(
				"This is it! Give me a thumbs up if this is helpful",
				{ reply_markup: defaultKeyboard() },
			);
		}
	}

	// Scenario:
	// - unknown unprecedented language
	// Set:
	// - `triedUnknownCommand` true
	ctx.session.triedUnknownCommand = true;
	return ctx.reply(
		"I'm sorry, I'm a bot and the only command I understand is /start; try hitting this button?",
	);
});

bot.catch((err) => {
	const ctx = err.ctx;
	console.error(`Error while handling update ${ctx.update.update_id}:`);
	console.error(err.error);
});

bot.api.setMyCommands([
	{ command: "start", description: "Start the bot" },
	{ command: "help", description: "Show help information" },
	{ command: "privacy", description: "Privacy policy" },
	{ command: "developer_info", description: "Developer contact information" },
	{ command: "delete", description: "Delete all your tracking data" },
]);

bot.start({
	allowed_updates: ["message", "message_reaction", "callback_query"],
}).catch((...args) => {
	console.log('Caught with errors: ', args);
});

/**
 * Get address if `objectId` has an `AddressOwner`
 * @param objectId
 */
async function getObjectOwner(objectId: string) {
	const result = await grpc.core.getObject({ objectId }).catch(() => null);

	// TODO: we only support AddressOwner, while there may be more cases to explore.
	if (result && result.object.owner.$kind == "AddressOwner") {
		return result.object.owner.AddressOwner;
	}

	return null;
}

/**
 * Get all `SuiNSRegistration` objects for an address. Goes through all pages
 * if present. Returns `null` if anything went wrong.
 * @param address
 */
async function getSuinsNamesForAddress(
	address: string,
	_cursor: string | null,
): Promise<(typeof SuinsRegistration.$inferType)[] | null> {
	let result = await grpc.core
		.getOwnedObjects({ address, type: NS_OBJECT_TYPE })
		.catch(() => null);

	if (result === null) {
		return result;
	}

	const objects: [string, Uint8Array][] = await Promise.all(
		result.objects.map(async (obj) => [obj.id, await obj.content]),
	);

	while (result.hasNextPage) {
		result = await grpc.core.getOwnedObjects({
			address,
			type: NS_OBJECT_TYPE,
			cursor: result.cursor,
		});

		let resolved: [string, Uint8Array][] = await Promise.all(
			result.objects.map(async (obj) => [obj.id, await obj.content]),
		);

		objects.push(...resolved);
	}

	const parsed = objects.map(([id, bytes]) => {
		const byteOffset = toHex(bytes).indexOf(id!.slice(2));

		if (byteOffset == -1 || byteOffset % 2 != 0) {
			console.log("Sorry, luv");
			return null;
		}

		const offsetBytes = bytes.slice(byteOffset / 2);
		return SuinsRegistration.parse(offsetBytes);
	});

	return parsed.filter((res) => res !== null);
}

/**
 * Use `NameService` API to look up `NameRecord` on a FN.
 * @param name Suins Name
 */
async function getNameRecord(name: string): Promise<NameRecord | null> {
	try {
		const result = await grpc.nameService.lookupName({ name });
		const record = result.response.record;
		return record || null;
	} catch (e) {
		return null;
	}
}

function prettyPrintListOfNames(
	address: string,
	names: (typeof SuinsRegistration.$inferType)[],
) {
	names.sort((a, b) => +a.expires_at - +b.expires_at);

	const header = `Here are all the names owned by ${address}\n\n`;
	const chunks: string[] = [];

	const last_chunk = names.reduce((acc, v, i) => {
		const daysLeft = (+v.expires_at - Date.now()) / (24 * 3600 * 1000);
		const expiration =
			daysLeft < 0
				? "already expired"
				: `expires in ${daysLeft.toFixed(0)} days`;

		const name = "@" + v.domain_name.replace(".sui", "");
		const link = `[${name}](https://suiscan.xyz/mainnet/object/${v.id})`;
		const escaped = link.replaceAll("-", "\\-");

		acc += `\\- ${escaped} ${expiration}\n`;

		if (i > 0 && i % 50 == 0) {
			chunks.push(acc);
			return "";
		}

		return acc;
	}, "");

	chunks.push(last_chunk);

	const footer = `\nTotal: ${names.length} names`;

	return {
		header,
		chunks,
		footer,
	};
}

// === Making Life Easier ===

function defaultKeyboard() {
	const kb = new InlineKeyboard()
		.text("Search names for address", SEARCH_ADDRESS)
		.row()
		.text("Search single name", SEARCH_NAME)
		.row()
		.text("My trackers", MY_TRACKERS);

	return kb;
}

// === Redis Features

/**
 * Return all tracked names for a single chat.
 */
async function getTrackedNames(chatId: string | number) {
	const key = `${REDIS_TRACKED_NAMES}:${chatId}`;
	return redis.smembers(key);
}

/**
 * Remove name from tracking.
 */
async function stopTracking(chatId: string, name: string) {
	const key = `${REDIS_TRACKED_NAMES}:${chatId}`;
	await redis.srem(key, name);
	// Also remove from global set if no one else is tracking this name
	const allTrackers = await redis.keys(`${REDIS_TRACKED_NAMES}:*`);
	let stillTracked = false;
	for (const trackerKey of allTrackers) {
		if (await redis.sismember(trackerKey, name)) {
			stillTracked = true;
			break;
		}
	}
	if (!stillTracked) {
		await redis.srem(REDIS_ALL_TRACKED_NAMES, name);
	}
}

/**
 * Returns all tracked names keyed by their `chat_id`.
 */
async function getAllNameTrackers(): Promise<Map<string, string[]>> {
	const allTrackers = await redis.keys(`${REDIS_TRACKED_NAMES}:*`);
	const result = new Map<string, string[]>();

	for (const key of allTrackers) {
		const chatId = key.replace(`${REDIS_TRACKED_NAMES}:`, "");
		const names = await redis.smembers(key);
		result.set(chatId, names);
	}

	return result;
}

function formatName(name: string): string {
	const pureName = name.replace(/\.sui$/, "");

	if (pureName.includes(".")) {
		return pureName.replaceAll(".", "@");
	} else {
		return "@" + pureName;
	}
}

// const singleNameTrackers = await redis.keys(`${REDIS_TRACKED_NAMES}:*`);
// 	for (const userTracker of singleNameTrackers) {
// 		const allKeys = await redis.smembers(userTracker);
// 		const chatId = userTracker.replace(`${REDIS_TRACKED_NAMES}:`, '');
// 		bot.api.sendMessage(chatId, `hey friend, you are tracking these names: ${allKeys}`);
// 	}
