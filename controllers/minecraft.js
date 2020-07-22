const MC = require("minecraft-protocol");
const { autoVersionForge } = require("minecraft-protocol-forge");
const messageEvents = ["chat.type.announcement", "chat.type.text"];

module.exports = class Minecraft extends require("./template.js") {
	constructor () {
		super();

		this.platform = sb.Platform.get("minecraft");
		if (!this.platform) {
			throw new sb.Error({
				message: "Minecraft platform has not been created"
			});
		}
		else if (!sb.Config.has("MINECRAFT_BOT_EMAIL", true)) {
			throw new sb.Error({
				message: "Cytube account email has not been configured"
			});
		}
		else if (!sb.Config.has("MINECRAFT_BOT_PASSWORD", true)) {
			throw new sb.Error({
				message: "Cytube account password has not been configured"
			});
		}

		/** @type {Map<Channel, Client>} */
		this.channelMap = new Map();
		this.channels = sb.Channel.getJoinableForPlatform(this.platform);

		for (const channelData of this.channels) {
			const data = channelData.Data;
			const client = MC.createClient({
				host: channelData.Specific_ID,
				port: data.port ?? null,
				username: sb.Config.get("MINECRAFT_BOT_EMAIL"),
				password: sb.Config.get("MINECRAFT_BOT_PASSWORD")
			});

			if (data.type === "forge") {
				autoVersionForge(client);
			}

			this.channelMap.set(channelData, client);
		}

		this.initListeners();
	}

	initListeners () {
		for (const [channelData, client] of Object.entries(this.channelMap)) {
			client.on("chat", async (packet) => {
				const messageData = JSON.parse(packet.message);
				if (!messageEvents.includes(messageData.translate)) {
					return;
				}

				const username = messageData.with[0].text.toLowerCase();
				const userData = await sb.User.get(username, false);
				if (!userData) {
					return;
				}

				const message = messageData.with[1];
				this.resolveUserMessage(channelData, userData, message);

				if (channelData.Mode === "Last seen") {
					await sb.Logger.updateLastSeen({ userData, channelData, message });
					return;
				}
				else if (channelData.Mode === "Inactive") {
					return;
				}
				else if (channelData.Mode === "Read") {
					return;
				}

				if (channelData.Custom_Code) {
					channelData.Custom_Code({
						type: "message",
						message: message,
						user: userData,
						channel: channelData
					});
				}

				const globalCustomCode = sb.Config.get("GLOBAL_CUSTOM_CHANNEL_CODE", false);
				if (globalCustomCode) {
					await globalCustomCode({
						type: "message",
						message: message,
						user: userData,
						channel: channelData
					});
				}

				sb.AwayFromKeyboard.checkActive(userData, channelData);
				sb.Reminder.checkActive(userData, channelData);

				if (channelData.Mirror) {
					this.mirror(message, userData, channelData);
				}

				if (username === this.platform.Self_Name) {
					return;
				}

				sb.Master.globalMessageListener(this.platform, channelData, userData, message);


				// Check and execute command if necessary
				if (sb.Command.is(message)) {
					const [command, ...args] = message.replace(sb.Command.prefix, "").split(" ").filter(Boolean);
					await this.handleCommand(command, userData, channelData, args, {});
				}
			});
		}
	}

	/**
	 * @param {string} message
	 * @param {Channel} channelData
	 */
	async send (message, channelData) {
		const client = this.channelMap.get(channelData);
		if (!client) {
			throw new sb.Error({
				message: "No Minecraft client found foor given channel",
				args: { channelData, message}
			});
		}

		client.write("chat", { message });
	}

	/**
	 * @param {string} message Private message
	 * @param {string} user User the private message will be sent to
	 */
	async pm (message, user) {
		throw new sb.Error({
			message: "Not yet implemented",
			args: { message, user }
		});
	}

	/**
	 * Handles the execution of a command and the reply should it be successful.
	 * @param {string} command
	 * @param {User} userData
	 * @param {Channel} channelData
	 * @param {string[]} [args]
	 * @param {Object} options = {}
	 * @returns {boolean} Whether or not a command has been executed.
	 */
	async handleCommand (command, userData, channelData, args = [], options = {}) {
		options.platform = options.platform ?? this.platform;

		const execution = await sb.Command.checkAndExecute(command, args, channelData, userData, options);
		if (!execution || !execution.reply) {
			return;
		}

		if (execution.replyWithPrivateMessage) {
			this.pm(execution.reply, userData.Name);
		}
		else {
			if (channelData.Mirror) {
				this.mirror(execution.reply, userData, true);
			}

			const message = await sb.Master.prepareMessage(execution.reply, channelData, { skipBanphrases: true });
			if (message) {
				this.send(message, channelData);
			}
		}
	}

	/**
	 * Destroys and cleans up the instance
	 */
	destroy () {
		this.channelMap.clear();
	}
};